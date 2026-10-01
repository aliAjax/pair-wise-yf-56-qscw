import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { format } from 'date-fns';

export type Severity = 'medium' | 'high' | 'critical';
export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface ResponseAction { id: string; title: string; kind: 'isolate' | 'block' | 'restore' | 'notify'; approvals: string[]; status: 'pending' | 'approved' | 'executed'; sensitive?: boolean; }
/** 审批委托：响应负责人把某个处置动作的审批权临时交给分析员，到期或撤销后失效。 */
export interface Delegation { id: string; actionId: string; from: 'responder'; to: 'analyst'; expiresAt: string; revoked: boolean; createdAt: string; }
export interface Incident {
  id: string; title: string; severity: Severity; status: 'investigating' | 'contained' | 'recovered'; affected: string[];
  subIncidents: SubIncident[]; actions: ResponseAction[]; timeline: TimelineEvent[];
}
interface State {
  incident: Incident;
  delegations: Delegation[];
  role: 'analyst' | 'responder' | 'legal' | 'viewer';
  demoMode: boolean;
  setRole: (role: State['role']) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  delegateAction: (actionId: string, expiresAt: string) => void;
  revokeDelegation: (delegationId: string) => void;
  reorderActions: (activeId: string, overId: string) => void;
  tick: () => void;
}

/** 某动作当前是否存在有效的审批委托（未撤销且未过期）。 */
export function activeDelegationFor(delegations: Delegation[], actionId: string, now: number = Date.now()): Delegation | undefined {
  return delegations.find((item) => item.actionId === actionId && !item.revoked && new Date(item.expiresAt).getTime() > now);
}
const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: ['responder'], status: 'pending', sensitive: true },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending' },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'pending', sensitive: true }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ]
};
const initialDelegations: Delegation[] = [
  { id: 'del-seed', actionId: 'act-1', from: 'responder', to: 'analyst', expiresAt: new Date(Date.now() + 2 * 3600000).toISOString(), revoked: false, createdAt: new Date(Date.now() - 3600000).toISOString() }
];
export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial, delegations: initialDelegations, role: 'analyst', demoMode: false,
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  addSubIncident: (payload) => { if (get().demoMode) return; set((state) => ({ incident: { ...state.incident, subIncidents: [...state.incident.subIncidents, { id: `sub-${Date.now()}`, ...payload, status: 'open' }], timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: '响应负责人', text: `创建子事件：${payload.title}` }, ...state.incident.timeline] } })); },
  approveAction: (id) => {
    if (get().demoMode) return;
    const state = get();
    if (state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action) return;
    // 同一审批人对同一动作只能有一条有效审批（防重复提交/双人同时提交）。
    if (action.approvals.includes(state.role)) return;
    // 分析员只有在持有针对该动作的有效委托时才能审批；委托过期或被撤销后一律拒绝。
    if (state.role === 'analyst' && !activeDelegationFor(state.delegations, id)) {
      set({ incident: { ...state.incident, timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: '分析员', text: `委托已过期或被撤销，审批被拒绝：${action.title}` }, ...state.incident.timeline] } });
      return;
    }
    const viaDelegation = state.role === 'analyst';
    set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? { ...item, approvals: [...item.approvals, state.role], status: item.approvals.length >= 1 && action.kind === 'isolate' ? 'approved' : item.status } : item), timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: state.role, text: viaDelegation ? `分析员凭委托审批处置动作：${action.title}` : `审批处置动作：${action.title}` }, ...state.incident.timeline] } });
  },
  executeAction: (id) => { const state = get(); const action = state.incident.actions.find((item) => item.id === id); if (!action || state.demoMode || state.role === 'viewer' || (action.kind === 'isolate' && action.approvals.length < 2)) return; set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? { ...item, status: 'executed' } : item), timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: state.role, text: `执行处置动作：${action.title}`, sensitive: action.sensitive }, ...state.incident.timeline] } }); },
  delegateAction: (actionId, expiresAt) => {
    if (get().demoMode) return;
    const state = get();
    if (state.role !== 'responder') return;
    const action = state.incident.actions.find((item) => item.id === actionId);
    if (!action) return;
    const now = Date.now();
    // 同一动作同一时间只保留一条有效委托，旧委托立即失效。
    const delegations = state.delegations.map((item) => item.actionId === actionId && !item.revoked ? { ...item, revoked: true } : item);
    const delegation: Delegation = { id: `del-${now}`, actionId, from: 'responder', to: 'analyst', expiresAt, revoked: false, createdAt: new Date(now).toISOString() };
    set({ delegations: [...delegations, delegation], incident: { ...state.incident, timeline: [{ id: `e-${now}`, at: new Date(now).toISOString(), actor: '响应负责人', text: `委托分析员临时审批处置动作：${action.title}（有效期至 ${format(new Date(expiresAt), 'MM-dd HH:mm')}）` }, ...state.incident.timeline] } });
  },
  revokeDelegation: (delegationId) => {
    if (get().demoMode) return;
    const state = get();
    if (state.role !== 'responder') return;
    const delegation = state.delegations.find((item) => item.id === delegationId);
    if (!delegation || delegation.revoked) return;
    const action = state.incident.actions.find((item) => item.id === delegation.actionId);
    set({ delegations: state.delegations.map((item) => item.id === delegationId ? { ...item, revoked: true } : item), incident: { ...state.incident, timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: '响应负责人', text: `撤销对分析员的审批委托：${action?.title ?? delegation.actionId}` }, ...state.incident.timeline] } });
  },
  reorderActions: (activeId, overId) => { const state = get(); const actions = [...state.incident.actions]; const from = actions.findIndex((item) => item.id === activeId); const to = actions.findIndex((item) => item.id === overId); if (from < 0 || to < 0 || state.demoMode) return; const [moved] = actions.splice(from, 1); actions.splice(to, 0, moved); set({ incident: { ...state.incident, actions } }); },
  tick: () => set((state) => ({ incident: { ...state.incident, timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: '监测代理', text: `实时检查：${state.incident.affected.length} 项资产状态已更新` }, ...state.incident.timeline].slice(0, 30) } }))
}), { name: 'yf56-incident-store-v2' }));
