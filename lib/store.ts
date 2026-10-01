import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Severity = 'medium' | 'high' | 'critical';
export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
// approver 是实际审批人的真实身份（角色），代理审批也记在代理人名下，用于"不同审批人/同一人不重复计入"判定
export interface Approval { approver: Role; at: string; viaDelegationId?: string; }
export type DelegationStatus = 'active' | 'revoked' | 'expired';
// 审批委托：仅针对单个处置动作（actionId），把负责人的审批权临时交给指定分析员
export interface Delegation {
  id: string;
  actionId: string;
  delegator: Role;
  delegatee: Role;
  grantedAt: string;
  expiresAt: string;
  status: DelegationStatus;
  revokedAt?: string;
}
export interface ResponseAction { id: string; title: string; kind: 'isolate' | 'block' | 'restore' | 'notify'; approvals: Approval[]; status: 'pending' | 'approved' | 'executed'; sensitive?: boolean; }
export interface Incident {
  id: string; title: string; severity: Severity; status: 'investigating' | 'contained' | 'recovered'; affected: string[];
  subIncidents: SubIncident[]; actions: ResponseAction[]; delegations: Delegation[]; timeline: TimelineEvent[];
}
interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  grantDelegation: (payload: { actionId: string; expiresAt: string }) => void;
  revokeDelegation: (id: string) => void;
  reorderActions: (activeId: string, overId: string) => void;
  tick: () => void;
}

const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const timelineEvent = (actor: string, text: string, at = Date.now(), sensitive?: boolean): TimelineEvent =>
  ({ id: uid('e'), at: new Date(at).toISOString(), actor, text, sensitive });

// 委托只在 active 且未过期时有效；查找始终以当前时间为准，过期瞬间的审批也会被拒绝
export function getActiveDelegation(delegations: Delegation[], actionId: string, delegatee: Role, now = Date.now()): Delegation | undefined {
  return delegations.find((item) =>
    item.actionId === actionId && item.delegatee === delegatee &&
    item.status === 'active' && new Date(item.expiresAt).getTime() > now);
}

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: [{ approver: 'analyst', at: new Date(Date.now() - 800000).toISOString() }], status: 'pending', sensitive: true },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending' },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: [{ approver: 'legal', at: new Date(Date.now() - 700000).toISOString() }], status: 'pending', sensitive: true }
  ],
  delegations: [],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ]
};
export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial, role: 'analyst', demoMode: false,
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  addSubIncident: (payload) => { if (get().demoMode) return; set((state) => ({ incident: { ...state.incident, subIncidents: [...state.incident.subIncidents, { id: uid('sub'), ...payload, status: 'open' }], timeline: [timelineEvent('响应负责人', `创建子事件：${payload.title}`), ...state.incident.timeline] } })); },
  approveAction: (id) => set((state) => {
    // 所有判定都在 set 内基于最新状态完成：并发/连点提交串行化处理，重复提交只会留下一条有效审批
    if (state.demoMode || state.role === 'viewer') return state;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || action.status === 'executed') return state;
    // 分析员自身无审批权，仅当持有本动作的有效委托时可代理；委托只影响这一个动作
    let delegation: Delegation | undefined;
    if (state.role === 'analyst') {
      delegation = getActiveDelegation(state.incident.delegations, id, 'analyst');
      if (!delegation) return state; // 委托不存在/已过期/已撤销 -> 审批被拒绝
    } else if (state.role === 'legal' && action.kind !== 'notify') {
      return state;
    }
    // 同一真人只能计一次：不能以"本人 + 代理"身份对同一动作重复审批
    if (action.approvals.some((item) => item.approver === state.role)) return state;
    const approval: Approval = { approver: state.role, at: new Date().toISOString() };
    if (delegation) approval.viaDelegationId = delegation.id;
    const approvals = [...action.approvals, approval];
    const required = action.kind === 'isolate' ? 2 : 1; // 隔离动作仍需两名不同审批人
    const status: ResponseAction['status'] = action.status === 'approved' || approvals.length >= required ? 'approved' : 'pending';
    const text = delegation
      ? `分析员经响应负责人委托代理审批处置动作：${action.title}`
      : `审批处置动作：${action.title}`;
    return {
      incident: {
        ...state.incident,
        actions: state.incident.actions.map((item) => item.id === id ? { ...item, approvals, status } : item),
        timeline: [timelineEvent(state.role, text), ...state.incident.timeline]
      }
    };
  }),
  executeAction: (id) => {
    const state = get();
    const action = state.incident.actions.find((item) => item.id === id);
    // 审批按真人去重，length 即不同审批人数；隔离不足两人不允许执行
    if (!action || state.demoMode || state.role === 'viewer' || (action.kind === 'isolate' && action.approvals.length < 2)) return;
    set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? { ...item, status: 'executed' } : item), timeline: [timelineEvent(state.role, `执行处置动作：${action.title}`, undefined, action.sensitive), ...state.incident.timeline] } });
  },
  grantDelegation: ({ actionId, expiresAt }) => {
    const state = get();
    if (state.demoMode || state.role !== 'responder') return; // 只有负责人可以委托
    const expires = new Date(expiresAt).getTime();
    if (!Number.isFinite(expires) || expires <= Date.now()) return;
    const action = state.incident.actions.find((item) => item.id === actionId);
    if (!action || getActiveDelegation(state.incident.delegations, actionId, 'analyst')) return; // 每个动作同时只保留一条有效委托
    const delegation: Delegation = {
      id: uid('dlg'), actionId, delegator: 'responder', delegatee: 'analyst',
      grantedAt: new Date().toISOString(), expiresAt: new Date(expires).toISOString(), status: 'active'
    };
    set({
      incident: {
        ...state.incident,
        delegations: [...state.incident.delegations, delegation],
        timeline: [timelineEvent('responder', `响应负责人将「${action.title}」的审批权临时委托给分析员代理，有效期至 ${new Date(expires).toLocaleString('zh-CN')}；委托仅对该动作生效`), ...state.incident.timeline]
      }
    });
  },
  revokeDelegation: (id) => {
    const state = get();
    if (state.demoMode || state.role !== 'responder') return;
    const delegation = state.incident.delegations.find((item) => item.id === id);
    if (!delegation || delegation.status !== 'active') return;
    const action = state.incident.actions.find((item) => item.id === delegation.actionId);
    set({
      incident: {
        ...state.incident,
        delegations: state.incident.delegations.map((item) => item.id === id ? { ...item, status: 'revoked', revokedAt: new Date().toISOString() } : item),
        // 撤销不删除任何既有审批记录与时间线
        timeline: [timelineEvent('responder', `响应负责人撤销了分析员对「${action?.title ?? delegation.actionId}」的审批委托，此后该动作的代理审批将被拒绝`), ...state.incident.timeline]
      }
    });
  },
  reorderActions: (activeId, overId) => { const state = get(); const actions = [...state.incident.actions]; const from = actions.findIndex((item) => item.id === activeId); const to = actions.findIndex((item) => item.id === overId); if (from < 0 || to < 0 || state.demoMode) return; const [moved] = actions.splice(from, 1); actions.splice(to, 0, moved); set({ incident: { ...state.incident, actions } }); },
  tick: () => set((state) => {
    const now = Date.now();
    let { delegations, timeline } = state.incident;
    // 过期委托统一翻状态并补时间线；记录保留，仅让后续代理审批失效
    const expired = delegations.filter((item) => item.status === 'active' && new Date(item.expiresAt).getTime() <= now);
    if (expired.length > 0) {
      delegations = delegations.map((item) => expired.some((done) => done.id === item.id) ? { ...item, status: 'expired' as const } : item);
      timeline = [...expired.map((item) => {
        const action = state.incident.actions.find((candidate) => candidate.id === item.actionId);
        return timelineEvent('系统', `分析员对「${action?.title ?? item.actionId}」的审批委托已到期失效，后续代理审批将被拒绝；已有审批记录保留`, now);
      }), ...timeline];
    }
    timeline = [timelineEvent('监测代理', `实时检查：${state.incident.affected.length} 项资产状态已更新`, now), ...timeline];
    return { incident: { ...state.incident, delegations, timeline: timeline.slice(0, 30) } };
  })
}), {
  name: 'yf56-incident-store',
  version: 1,
  migrate: (persisted: unknown, version: number) => {
    const data = persisted as { incident?: Incident };
    if (version < 1 && data?.incident) {
      const now = new Date().toISOString();
      data.incident.actions = data.incident.actions.map((action) => ({
        ...action,
        // 旧数据 approvals 为角色字符串数组，升级为带身份的审批记录，历史审批不丢失
        approvals: action.approvals.map((approval) =>
          typeof approval === 'string' ? { approver: approval, at: now } : approval)
      }));
      data.incident.delegations ??= [];
    }
    return data;
  }
}));
