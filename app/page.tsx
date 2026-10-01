'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Eye, Radio, ShieldAlert, TimerReset, UserCheck, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getActiveDelegation, useIncidentStore, type ResponseAction, type Role } from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const roleNames: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const kindNames: Record<ResponseAction['kind'], string> = { isolate: '隔离', block: '封禁', restore: '恢复', notify: '通知' };

function toLocalInputValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const canSee = !action.sensitive || ['responder', 'legal'].includes(store.role);
  const activeDelegation = getActiveDelegation(store.incident.delegations, action.id, 'analyst');
  const actionDelegations = store.incident.delegations
    .filter((item) => item.actionId === action.id)
    .sort((a, b) => +new Date(b.grantedAt) - +new Date(a.grantedAt));
  const isProxy = store.role === 'analyst' && !!activeDelegation;
  const ownApproval = action.approvals.some((item) => item.approver === store.role);
  let rejectReason = '';
  if (store.role !== 'viewer' && !ownApproval && action.status !== 'executed') {
    if (store.role === 'analyst' && !activeDelegation) {
      const latest = actionDelegations[0];
      rejectReason = latest?.status === 'revoked' ? '该动作的审批委托已被撤销，代理审批被拒绝'
        : latest?.status === 'expired' ? '该动作的审批委托已过期，代理审批被拒绝'
        : '分析员无直接审批权：需响应负责人对本动作授予有效委托';
    } else if (store.role === 'legal' && action.kind !== 'notify') {
      rejectReason = '法务/公关仅可审批通知口径动作';
    }
  }
  const [expiresAt, setExpiresAt] = useState(() => toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [grantError, setGrantError] = useState('');
  function grant() {
    const expires = new Date(expiresAt).getTime();
    if (!Number.isFinite(expires) || expires <= Date.now()) { setGrantError('失效时间需晚于当前时间'); return; }
    setGrantError('');
    store.grantDelegation({ actionId: action.id, expiresAt });
  }

  return (
    <>
      <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className={actionDelegations.length > 0 ? 'action-row action-row-last' : 'action-row'}>
        <div><strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
          <div className="muted">{kindNames[action.kind]} · 审批人 {action.approvals.map((item) => `${roleNames[item.approver]}${item.viaDelegationId ? '（代理）' : ''}`).join('、') || '无'} · {action.status}{action.kind === 'isolate' && ' · 需两名不同审批人'}</div>
          {rejectReason && <div className="reject-hint">{rejectReason}</div>}
        </div>
        <div className="row-actions">
          <Button size="sm" variant="outline" title={rejectReason} disabled={store.demoMode || store.role === 'viewer' || ownApproval || action.status === 'executed' || !!(store.role === 'analyst' && !activeDelegation) || (store.role === 'legal' && action.kind !== 'notify')} onClick={() => store.approveAction(action.id)}><UserCheck size={14} />{isProxy ? '代理审批' : '审批'}</Button>
          <Button size="sm" disabled={store.demoMode || store.role === 'viewer'} onClick={() => store.executeAction(action.id)}>执行</Button>
          <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
        </div>
      </div>
      {actionDelegations.length > 0 && (
        <div className="delegation-row">
          {store.role === 'responder' ? (
            activeDelegation ? <>
              <TimerReset size={13} />
              <span>已委托分析员代理审批本动作，{formatDistanceToNow(new Date(activeDelegation.expiresAt), { addSuffix: true, locale: zhCN })}失效</span>
              <Button size="sm" variant="ghost" disabled={store.demoMode} onClick={() => store.revokeDelegation(activeDelegation.id)}>撤销委托</Button>
            </> : <>
              <label className="delegation-field">新委托失效时间
                <Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
              </label>
              {grantError && <small className="error delegation-error">{grantError}</small>}
              <Button size="sm" variant="outline" disabled={store.demoMode} onClick={grant}>委托分析员代理审批</Button>
            </>
          ) : (
            <span className="muted"><TimerReset size={13} />{activeDelegation
              ? `响应负责人已委托分析员代理审批本动作，${formatDistanceToNow(new Date(activeDelegation.expiresAt), { addSuffix: true, locale: zhCN })}失效`
              : `最近一次委托${actionDelegations[0].status === 'revoked' ? '已被撤销' : '已过期'}：代理审批将被拒绝，既有审批记录保留`}</span>
          )}
          {activeDelegation && !store.demoMode && store.role === 'responder' && (
            <div className="delegation-renew muted">如需改派或调整失效时间，请先撤销当前委托</div>
          )}
        </div>
      )}
      {store.role === 'responder' && actionDelegations.length === 0 && (
        <div className="delegation-row">
          <label className="delegation-field">委托失效时间
            <Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </label>
          {grantError && <small className="error delegation-error">{grantError}</small>}
          <Button size="sm" variant="outline" disabled={store.demoMode} onClick={grant}><TimerReset size={14} />委托分析员代理审批</Button>
        </div>
      )}
    </>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: async () => ({ connected: true, latency: 42 }), refetchInterval: 10000 });
  useEffect(() => { const timer = window.setInterval(() => { if (!store.demoMode) store.tick(); }, 20000); return () => window.clearInterval(timer); }, [store.demoMode]);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = ['responder', 'legal'].includes(store.role);

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="controls"><select value={store.role} onChange={(event) => store.setRole(event.target.value as Role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button></div></header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、委托、执行、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    <section className="metrics"><Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card><Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : '离线'}</strong><small>{health.connected ? '监测代理已连接' : '等待连接'}</small></CardContent></Card><Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card><Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/总数</small></CardContent></Card></section>
    <section className="grid">
      <div className="stack">
        <Card><CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader><CardContent><div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div><h3>子事件</h3>{incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}</CardContent></Card>
        <Card><CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离动作需两名不同审批人；负责人可把单个动作的审批权临时委托给分析员并设置失效时间，委托过期或撤销后代理审批即被拒绝，已有审批记录始终保留。</p></div><Users size={20} /></CardHeader><CardContent><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div></SortableContext></DndContext></CardContent></Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={store.demoMode}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">每 20 秒接收一次模拟监测事件</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{roleNames[event.actor as Role] ?? event.actor}</strong><span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}</div></CardContent></Card>
      </div>
    </section>
  </main>;
}
