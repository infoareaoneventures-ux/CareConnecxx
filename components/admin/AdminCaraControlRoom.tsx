import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BellRing, Check, Clock, ExternalLink, MessageSquare,
  RefreshCw, RotateCcw, Search, ShieldAlert, Sparkles, UserCheck, XCircle,
} from 'lucide-react';
import { dbService } from '../../services/api';
import { Badge } from '../ui/Badge';
import { SupportTicket } from '../../types';

type AdminTabTarget = 'alerts' | 'audit' | 'tickets' | 'messages' | 'proactive_drafts' | 'finance' | 'disputes';

interface Props {
  onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
  onNavigate?: (tab: AdminTabTarget) => void;
}

interface AdminAlertRecord {
  id: string;
  type?: string;
  severity?: string;
  source?: string;
  message?: string;
  reason?: string;
  error?: string;
  phone?: string;
  userId?: string;
  chatId?: string;
  actionId?: string;
  toolName?: string;
  recipeId?: string;
  sourceAgent?: string;
  resolved?: boolean;
  createdAt?: string;
  [key: string]: unknown;
}

interface LedgerRecord {
  id: string;
  actionType?: string;
  status?: string;
  userId?: string;
  phone?: string;
  role?: string;
  toolName?: string;
  targetCollection?: string;
  targetDocId?: string;
  errorReason?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  assignedTo?: string;
  assignedAt?: string;
  handledBy?: string;
  handledAt?: string;
  handledReason?: string;
  operatorNotes?: string;
  recoveryAction?: string;
  retryCount?: number;
  lastRetryAt?: string;
}

interface PendingActionRecord {
  id: string;
  phone?: string;
  userId?: string;
  toolName?: string;
  preview?: string;
  status?: string;
  proposedAt?: string;
  expiresAt?: string;
  resolvedAt?: string;
  executionPreview?: string;
  operatorNotes?: string;
  recoveryAction?: string;
  reProposedAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
}

interface DraftRecord {
  id: string;
  status?: string;
  severity?: string;
  phone?: string;
  userId?: string;
  reason?: string;
  draftText?: string;
  sendError?: string;
  createdAt?: string;
}

interface TurnMetricRecord {
  id: string;
  source?: string;
  at?: string;
  phone?: string;
  userId?: string;
  userType?: string;
  inputChannel?: string;
  pathway?: string;
  qualityFlags?: string[];
  errored?: boolean;
  errorClass?: string | null;
  replyEmpty?: boolean;
  durationMs?: number;
  quickReplyUsed?: boolean;
  fallbackPathUsed?: boolean;
  toolErrors?: number;
  toolNames?: string[];
  conversationRepairTriggered?: boolean;
  conversationRepairApplied?: boolean;
  supportDeflectionDetected?: boolean;
  genericHelpAskDetected?: boolean;
  medicationInstructionDetected?: boolean;
  confidenceClaimDetected?: boolean;
  promiseWithoutToolCall?: boolean;
  recipeWithoutBackingTool?: boolean;
  contextIgnoredWhenPresent?: boolean;
  paymentAuthorityLeakDetected?: boolean;
  multiQuestionDataCollection?: boolean;
  frustrationDetected?: boolean;
  rephraseLoopDetected?: boolean;
  repeatedGreetingDetected?: boolean;
  [key: string]: unknown;
}

type QueueKind =
  | 'alert'
  | 'failed_action'
  | 'pending_approval'
  | 'support_ticket'
  | 'draft'
  | 'quality_issue';

type QueueFilter =
  | 'all'
  | 'critical'
  | 'failed_actions'
  | 'pending_approvals'
  | 'linq'
  | 'qa'
  | 'support'
  | 'drafts'
  | 'payments'
  | 'recipes'
  | 'healthcare';

interface QueueItem {
  id: string;
  kind: QueueKind;
  category: string;
  title: string;
  detail: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  status: string;
  createdAt?: string;
  phone?: string;
  userId?: string;
  toolName?: string;
  targetTab?: AdminTabTarget;
  raw: Record<string, unknown>;
}

const FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'critical', label: 'Critical' },
  { id: 'failed_actions', label: 'Failed actions' },
  { id: 'pending_approvals', label: 'Pending approvals' },
  { id: 'linq', label: 'Linq' },
  { id: 'qa', label: 'QA' },
  { id: 'support', label: 'Support' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'payments', label: 'Payments' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'healthcare', label: 'Healthcare' },
];

const severityRank: Record<QueueItem['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function normalizeSeverity(value?: string): QueueItem['severity'] {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low' || value === 'info') return value;
  if (value === 'warning') return 'medium';
  return 'medium';
}

function severityVariant(severity: QueueItem['severity']): 'danger' | 'warning' | 'info' | 'neutral' {
  if (severity === 'critical' || severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  if (severity === 'info') return 'info';
  return 'neutral';
}

function formatDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ageMinutes(value?: string): number {
  if (!value) return 0;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
}

function truncate(value: unknown, max = 220): string {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function itemMatchesFilter(item: QueueItem, filter: QueueFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'critical') return item.severity === 'critical' || item.severity === 'high';
  if (filter === 'failed_actions') return item.kind === 'failed_action' || item.status === 'failed';
  if (filter === 'pending_approvals') return item.kind === 'pending_approval';
  if (filter === 'support') return item.kind === 'support_ticket';
  if (filter === 'drafts') return item.kind === 'draft';
  const haystack = `${item.category} ${item.title} ${item.detail} ${item.toolName ?? ''}`.toLowerCase();
  return haystack.includes(filter);
}

function makeAlertItem(alert: AdminAlertRecord): QueueItem {
  const type = alert.type ?? 'admin_alert';
  const detail = truncate(alert.message ?? alert.reason ?? alert.error ?? 'No details provided');
  const category = alert.recipeId || type.includes('family_group') || type.includes('recipe') ? 'recipes'
    : type.includes('linq') ? 'linq'
    : type.includes('qa') || type.includes('agent') || type.includes('cara') ? 'qa'
      : type.includes('payment') || type.includes('invoice') || type.includes('billing') ? 'payments'
        : type.includes('healthcare') || type.includes('medical') || type.includes('crisis') ? 'healthcare'
          : 'alert';
  return {
    id: `alert:${alert.id}`,
    kind: 'alert',
    category,
    title: type.replace(/_/g, ' '),
    detail,
    severity: normalizeSeverity(alert.severity),
    status: alert.resolved ? 'resolved' : 'open',
    createdAt: alert.createdAt,
    phone: alert.phone,
    userId: alert.userId,
    toolName: alert.toolName ?? alert.sourceAgent,
    targetTab: 'alerts',
    raw: alert,
  };
}

function makeLedgerItem(entry: LedgerRecord): QueueItem {
  const action = entry.actionType ?? 'agent_action';
  const title = `${action.replace(/_/g, ' ')}${entry.toolName ? ` via ${entry.toolName}` : ''}`;
  const haystack = `${action} ${entry.toolName ?? ''} ${String(entry.metadata?.recipeId ?? '')} ${String(entry.metadata?.sourceAgent ?? '')}`;
  const category = haystack.includes('family_group') || haystack.includes('recipe') || !!entry.metadata?.recipeId ? 'recipes'
    : haystack.includes('linq') ? 'linq'
      : haystack.includes('healthcare') ? 'healthcare'
    : haystack.includes('payment') ? 'payments'
      : 'failed_actions';
  return {
    id: `ledger:${entry.id}`,
    kind: 'failed_action',
    category,
    title,
    detail: truncate(entry.errorReason ?? entry.metadata?.preview ?? 'Action failed without a captured error reason'),
    severity: action.includes('healthcare') || action.includes('payment') ? 'high' : 'medium',
    status: entry.status ?? 'failed',
    createdAt: entry.updatedAt ?? entry.createdAt,
    phone: entry.phone,
    userId: entry.userId,
    toolName: entry.toolName,
    targetTab: 'audit',
    raw: entry as unknown as Record<string, unknown>,
  };
}

function makePendingItem(action: PendingActionRecord): QueueItem {
  const expiresAt = action.expiresAt ? new Date(action.expiresAt).getTime() : 0;
  const isExpired = !!expiresAt && expiresAt < Date.now();
  const executingStale = action.status === 'executing' && ageMinutes(action.proposedAt) >= 10;
  return {
    id: `pending:${action.id}`,
    kind: 'pending_approval',
    category: action.toolName === 'perform_web_action' ? 'healthcare' : 'pending_approvals',
    title: action.preview ?? action.toolName ?? 'Pending Cara approval',
    detail: action.executionPreview
      ? truncate(action.executionPreview)
      : isExpired
        ? 'Confirmation window expired.'
        : 'Waiting for explicit YES/NO confirmation.',
    severity: isExpired || executingStale ? 'high' : action.toolName === 'perform_web_action' ? 'high' : 'medium',
    status: isExpired && action.status === 'awaiting' ? 'expired-awaiting' : action.status ?? 'awaiting',
    createdAt: action.proposedAt,
    phone: action.phone,
    userId: action.userId,
    toolName: action.toolName,
    targetTab: 'audit',
    raw: action as unknown as Record<string, unknown>,
  };
}

function makeTicketItem(ticket: SupportTicket): QueueItem {
  return {
    id: `ticket:${ticket.id}`,
    kind: 'support_ticket',
    category: 'support',
    title: ticket.subject || 'Support ticket',
    detail: truncate(ticket.description),
    severity: ticket.priority === 'urgent' ? 'critical' : ticket.priority === 'high' ? 'high' : 'medium',
    status: ticket.status,
    createdAt: ticket.createdAt,
    userId: ticket.userId,
    targetTab: 'tickets',
    raw: ticket as unknown as Record<string, unknown>,
  };
}

function makeDraftItem(draft: DraftRecord): QueueItem {
  const failed = draft.status === 'send_failed';
  return {
    id: `draft:${draft.id}`,
    kind: 'draft',
    category: 'drafts',
    title: failed ? 'Cara draft send failed' : 'Cara draft needs review',
    detail: truncate(draft.sendError ?? draft.reason ?? draft.draftText),
    severity: failed ? 'high' : normalizeSeverity(draft.severity),
    status: draft.status ?? 'pending_review',
    createdAt: draft.createdAt,
    phone: draft.phone,
    userId: draft.userId,
    targetTab: 'proactive_drafts',
    raw: draft as unknown as Record<string, unknown>,
  };
}

const QUALITY_FLAG_LABELS: Record<string, string> = {
  agent_loop_exhausted: 'Agent loop exhausted',
  confidence_claim_detected: 'Confidence claim',
  context_ignored_when_present: 'Live context ignored',
  conversation_repair_applied: 'Conversation repair applied',
  conversation_repair_triggered: 'Conversation repair triggered',
  fallback_path_used: 'Fallback path',
  frustration_detected: 'User frustration',
  generic_help_ask_detected: 'Generic helper prompt',
  grounding_triggered: 'Safety grounding',
  medication_instruction_detected: 'Medication instruction risk',
  multi_question_data_collection: 'Multi-question intake',
  payment_authority_leak_detected: 'Payment authority leak',
  post_process_modified: 'Post-process rewrite',
  promise_without_tool_call: 'Promise without tool call',
  recipe_without_backing_tool: 'Recipe without backing tool',
  repeated_greeting_detected: 'Repeated greeting loop',
  rephrase_loop_detected: 'Rephrase loop',
  reply_empty: 'Empty reply',
  support_deflection_detected: 'Support deflection',
  tool_error: 'Tool error',
  tool_truncation: 'Tool truncation',
  turn_errored: 'Turn error',
};

function readableQualityFlags(metric: TurnMetricRecord): string[] {
  const flags = new Set(metric.qualityFlags ?? []);
  if (metric.errored) flags.add('turn_errored');
  if (metric.replyEmpty) flags.add('reply_empty');
  if ((metric.toolErrors ?? 0) > 0) flags.add('tool_error');
  if (metric.fallbackPathUsed) flags.add('fallback_path_used');
  if (metric.conversationRepairApplied) flags.add('conversation_repair_applied');
  if (metric.supportDeflectionDetected) flags.add('support_deflection_detected');
  if (metric.genericHelpAskDetected) flags.add('generic_help_ask_detected');
  if (metric.medicationInstructionDetected) flags.add('medication_instruction_detected');
  if (metric.recipeWithoutBackingTool) flags.add('recipe_without_backing_tool');
  if (metric.contextIgnoredWhenPresent) flags.add('context_ignored_when_present');
  if (metric.paymentAuthorityLeakDetected) flags.add('payment_authority_leak_detected');
  if (metric.frustrationDetected) flags.add('frustration_detected');
  if (metric.rephraseLoopDetected) flags.add('rephrase_loop_detected');
  if (metric.repeatedGreetingDetected) flags.add('repeated_greeting_detected');
  return Array.from(flags).map((flag) => QUALITY_FLAG_LABELS[flag] ?? flag.replace(/_/g, ' '));
}

function makeQualityMetricItem(metric: TurnMetricRecord): QueueItem {
  const labels = readableQualityFlags(metric);
  const severe = metric.errored || metric.replyEmpty || metric.medicationInstructionDetected || metric.supportDeflectionDetected || metric.paymentAuthorityLeakDetected || metric.frustrationDetected || metric.rephraseLoopDetected;
  const title = metric.conversationRepairApplied
    ? 'Conversation repair applied'
    : metric.errored
      ? 'Cara turn error'
      : 'Conversation quality flag';
  const detailParts = [
    labels.length ? labels.join(', ') : 'Quality signal captured',
    metric.pathway ? `pathway: ${metric.pathway}` : '',
    typeof metric.durationMs === 'number' ? `${metric.durationMs}ms` : '',
    metric.toolNames?.length ? `tools: ${metric.toolNames.join(', ')}` : '',
  ].filter(Boolean);
  return {
    id: `quality:${metric.id}`,
    kind: 'quality_issue',
    category: 'qa',
    title,
    detail: truncate(detailParts.join(' | ')),
    severity: severe ? 'high' : 'medium',
    status: metric.errored ? 'errored' : metric.conversationRepairApplied ? 'repaired' : 'flagged',
    createdAt: metric.at,
    phone: metric.phone,
    userId: metric.userId,
    toolName: metric.toolNames?.join(', '),
    targetTab: 'messages',
    raw: metric as unknown as Record<string, unknown>,
  };
}

const EmptyState: React.FC = () => (
  <div className="h-full flex items-center justify-center text-center text-slate-500">
    <div>
      <Check className="w-10 h-10 mx-auto mb-3 text-emerald-500" />
      <p className="font-semibold text-slate-800">No Cara ops items match this filter.</p>
      <p className="text-sm mt-1">Failed actions, pending confirmations, alerts, quality flags, and support escalations appear here.</p>
    </div>
  </div>
);

export const AdminCaraControlRoom: React.FC<Props> = ({ onShowToast, onNavigate }) => {
  const [alerts, setAlerts] = useState<AdminAlertRecord[]>([]);
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingActionRecord[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [qualityMetrics, setQualityMetrics] = useState<TurnMetricRecord[]>([]);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolvingAlertId, setResolvingAlertId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [operatorNote, setOperatorNote] = useState('');
  const [handledReason, setHandledReason] = useState('');
  const [recoveryOwner, setRecoveryOwner] = useState('');
  const [highRiskConfirm, setHighRiskConfirm] = useState(false);

  useEffect(() => {
    const unsubscribers = [
      dbService.subscribeAdminAlerts((rows) => setAlerts(rows as AdminAlertRecord[]), () => onShowToast('Failed to load Cara alerts', 'error')),
      dbService.subscribeAgentActionLedger((rows) => setLedger(rows as LedgerRecord[]), () => onShowToast('Failed to load Cara action ledger', 'error')),
      dbService.subscribePendingActions((rows) => setPendingActions(rows as PendingActionRecord[]), () => onShowToast('Failed to load pending Cara actions', 'error')),
      dbService.subscribeToTickets((rows) => setTickets(rows)),
      dbService.subscribeProactiveDrafts([], (rows) => setDrafts(rows as DraftRecord[])),
      dbService.subscribeCaraTurnMetrics((rows) => setQualityMetrics(rows as TurnMetricRecord[]), () => onShowToast('Failed to load Cara quality metrics', 'error')),
    ];
    return () => unsubscribers.forEach((unsub) => unsub());
  }, [onShowToast]);

  const queueItems = useMemo(() => {
    const openAlerts = alerts.filter((a) => !a.resolved).map(makeAlertItem);
    const failedLedger = ledger.filter((e) => e.status === 'failed').map(makeLedgerItem);
    const activePending = pendingActions
      .filter((p) => ['awaiting', 'executing', 'failed'].includes(String(p.status ?? 'awaiting')))
      .map(makePendingItem);
    const activeTickets = tickets
      .filter((t) => t.status === 'open' || t.status === 'in-progress')
      .map(makeTicketItem);
    const activeDrafts = drafts
      .filter((d) => d.status === 'pending_review' || d.status === 'send_failed' || d.status === 'expired')
      .map(makeDraftItem);
    const activeQuality = qualityMetrics
      .filter((m) => (m.qualityFlags?.length ?? 0) > 0 || m.errored || m.replyEmpty)
      .map(makeQualityMetricItem);

    return [...openAlerts, ...failedLedger, ...activePending, ...activeTickets, ...activeDrafts, ...activeQuality]
      .sort((a, b) => {
        const severityDelta = severityRank[a.severity] - severityRank[b.severity];
        if (severityDelta !== 0) return severityDelta;
        return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
      });
  }, [alerts, ledger, pendingActions, tickets, drafts, qualityMetrics]);

  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return queueItems.filter((item) => {
      if (!itemMatchesFilter(item, filter)) return false;
      if (!needle) return true;
      return [
        item.title,
        item.detail,
        item.phone,
        item.userId,
        item.toolName,
        item.status,
        item.category,
      ].filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [queueItems, filter, search]);

  const selected = filteredItems.find((item) => item.id === selectedId) ?? filteredItems[0] ?? null;

  useEffect(() => {
    setOperatorNote('');
    setHandledReason('');
    setRecoveryOwner('');
    setHighRiskConfirm(false);
  }, [selected?.id]);

  // A fresh idempotency key per executable attempt — guards the backend against
  // double-execution if the operator double-clicks or a retry is re-submitted.
  function newIdempotencyKey(prefix: string, id: string): string {
    return `${prefix}:${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  // Healthcare write actions (perform_web_action) are always treated as
  // high-risk for replay, matching the backend isHighRisk gate.
  function isHighRiskReplay(item: QueueItem): boolean {
    return item.toolName === 'perform_web_action';
  }

  const stats = useMemo(() => {
    const critical = queueItems.filter((item) => item.severity === 'critical' || item.severity === 'high').length;
    const failed = queueItems.filter((item) => item.kind === 'failed_action' || item.status === 'failed').length;
    const pending = queueItems.filter((item) => item.kind === 'pending_approval').length;
    const delivery = queueItems.filter((item) => item.category === 'linq').length;
    return { total: queueItems.length, critical, failed, pending, delivery };
  }, [queueItems]);

  async function resolveSelectedAlert(item: QueueItem) {
    if (item.kind !== 'alert') return;
    const rawId = String(item.raw.id ?? '').trim();
    if (!rawId) return;
    setResolvingAlertId(rawId);
    try {
      await dbService.resolveAdminAlert(rawId);
      onShowToast('Cara alert marked resolved', 'success');
    } catch (err) {
      console.error('resolve Cara alert failed:', err);
      onShowToast('Failed to resolve Cara alert', 'error');
    } finally {
      setResolvingAlertId(null);
    }
  }

  function rawId(item: QueueItem): string {
    return String(item.raw.id ?? '').trim();
  }

  async function assignSelectedAction(item: QueueItem) {
    const id = rawId(item);
    if (!id) return;
    setBusyAction(`assign:${id}`);
    try {
      const target = item.kind === 'failed_action' ? { ledgerId: id } : { alertId: id };
      const owner = recoveryOwner.trim() ? { ownerLabel: recoveryOwner.trim() } : {};
      await dbService.adminAssignRecoveryOwner(target, owner);
      onShowToast('Recovery owner assigned', 'success');
    } catch (err) {
      console.error('assign recovery owner failed:', err);
      onShowToast('Failed to assign recovery owner', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  // Executable retry (U4). Linq-category failures re-attempt the outbound send;
  // every other failed tool action re-dispatches via the agent-action retry.
  // Both run on the backend, are idempotency-keyed, and fail visibly.
  async function requestRetryForSelectedAction(item: QueueItem) {
    const id = rawId(item);
    if (!id) return;
    setBusyAction(`retry:${id}`);
    try {
      const key = newIdempotencyKey('retry', id);
      const res = item.category === 'linq'
        ? await dbService.adminRetryLinqDelivery(key, { ledgerId: id })
        : await dbService.adminRetryAgentAction(id, key);
      if (res?.success) {
        onShowToast('Retry executed successfully', 'success');
      } else {
        onShowToast(`Retry failed: ${res?.error ?? 'see admin alerts'}`, 'error');
      }
    } catch (err) {
      console.error('execute Cara action retry failed:', err);
      onShowToast(`Retry failed: ${(err as Error)?.message ?? 'backend error'}`, 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function markSelectedActionHandled(item: QueueItem) {
    const id = rawId(item);
    if (!id) return;
    if (!handledReason.trim()) {
      onShowToast('Handled reason is required', 'error');
      return;
    }
    setBusyAction(`handled:${id}`);
    try {
      const target = item.kind === 'failed_action' ? { ledgerId: id } : { alertId: id };
      await dbService.adminMarkRecoveryComplete(target, handledReason.trim());
      onShowToast('Recovery marked complete', 'success');
    } catch (err) {
      console.error('mark recovery complete failed:', err);
      onShowToast(`Failed to mark complete: ${(err as Error)?.message ?? 'backend error'}`, 'error');
    } finally {
      setBusyAction(null);
    }
  }

  // Executable cancel (U4). Transitions the pending action to a terminal
  // cancelled state on the backend WITHOUT running the underlying tool.
  async function cancelSelectedPendingAction(item: QueueItem) {
    const id = rawId(item);
    if (!id) return;
    if (!operatorNote.trim()) {
      onShowToast('Add a cancel reason first', 'error');
      return;
    }
    setBusyAction(`cancel:${id}`);
    try {
      await dbService.adminCancelPendingAction(id, operatorNote.trim());
      onShowToast('Pending Cara approval cancelled (tool not executed)', 'success');
    } catch (err) {
      console.error('cancel pending Cara action failed:', err);
      onShowToast(`Failed to cancel: ${(err as Error)?.message ?? 'backend error'}`, 'error');
    } finally {
      setBusyAction(null);
    }
  }

  // Executable replay (U4). Re-runs the pending action's tool on the backend.
  // High-risk replays require the operator to tick the confirmation box.
  async function replaySelectedPendingAction(item: QueueItem) {
    const id = rawId(item);
    if (!id) return;
    const highRisk = isHighRiskReplay(item);
    if (highRisk && !highRiskConfirm) {
      onShowToast('High-risk replay needs explicit confirmation', 'error');
      return;
    }
    setBusyAction(`replay:${id}`);
    try {
      const key = newIdempotencyKey('replay', id);
      const res = await dbService.adminReplayPendingAction(id, key, highRisk ? highRiskConfirm : false);
      if (res?.success) {
        onShowToast('Pending action replayed successfully', 'success');
      } else {
        onShowToast(`Replay failed: ${res?.error ?? 'see admin alerts'}`, 'error');
      }
    } catch (err) {
      console.error('replay pending Cara action failed:', err);
      onShowToast(`Replay failed: ${(err as Error)?.message ?? 'backend error'}`, 'error');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="h-full bg-slate-50 flex flex-col overflow-hidden">
      <div className="px-5 py-4 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary-600" />
              <h2 className="text-lg font-bold text-slate-900">Cara Control Room</h2>
            </div>
            <p className="text-sm text-slate-500 mt-1">
              Live queue for failed actions, pending confirmations, Linq delivery issues, support escalations, and draft review.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <RefreshCw className="w-3.5 h-3.5" />
            Live Firestore listeners
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-4">
          <Stat label="Total queue" value={stats.total} icon={<BellRing className="w-4 h-4" />} />
          <Stat label="High risk" value={stats.critical} icon={<ShieldAlert className="w-4 h-4" />} tone="danger" />
          <Stat label="Failed actions" value={stats.failed} icon={<AlertTriangle className="w-4 h-4" />} tone="warning" />
          <Stat label="Pending approvals" value={stats.pending} icon={<Clock className="w-4 h-4" />} />
          <Stat label="Delivery issues" value={stats.delivery} icon={<MessageSquare className="w-4 h-4" />} />
        </div>
      </div>

      <div className="px-5 py-3 bg-white border-b border-slate-200 flex flex-wrap items-center gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setFilter(item.id);
              setSelectedId(null);
            }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              filter === item.id
                ? 'bg-primary-600 text-white border-primary-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {item.label}
          </button>
        ))}
        <div className="ml-auto relative min-w-[260px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search phone, user, tool, detail..."
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-200"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="w-[460px] bg-white border-r border-slate-200 overflow-y-auto">
          {filteredItems.length === 0 ? (
            <EmptyState />
          ) : (
            filteredItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors ${
                  selected?.id === item.id ? 'bg-primary-50/60' : ''
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant={severityVariant(item.severity)}>{item.severity}</Badge>
                  <span className="text-xs font-medium text-slate-500 uppercase">{item.category}</span>
                  <span className="ml-auto text-xs text-slate-400">{formatDate(item.createdAt)}</span>
                </div>
                <p className="font-semibold text-sm text-slate-900 line-clamp-1">{item.title}</p>
                <p className="text-sm text-slate-600 line-clamp-2 mt-1">{item.detail}</p>
                <div className="flex items-center gap-2 mt-2 text-xs text-slate-400">
                  <span>{item.status}</span>
                  {item.phone && <span className="font-mono">{item.phone}</span>}
                  {item.toolName && <span>{item.toolName}</span>}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {!selected ? (
            <EmptyState />
          ) : (
            <div className="max-w-4xl mx-auto p-6 space-y-5">
              <div className="bg-white border border-slate-200 rounded-lg p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant={severityVariant(selected.severity)}>{selected.severity}</Badge>
                      <Badge variant="secondary">{selected.kind.replace(/_/g, ' ')}</Badge>
                      <Badge variant="neutral">{selected.status}</Badge>
                    </div>
                    <h3 className="text-xl font-bold text-slate-900">{selected.title}</h3>
                    <p className="text-sm text-slate-600 mt-2">{selected.detail}</p>
                  </div>
                  {selected.kind === 'alert' && (
                    <button
                      onClick={() => resolveSelectedAlert(selected)}
                      disabled={resolvingAlertId === selected.raw.id}
                      className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Check className="w-4 h-4" />
                      {resolvingAlertId === selected.raw.id ? 'Resolving...' : 'Resolve'}
                    </button>
                  )}
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <DetailBlock title="Identity">
                  <DetailRow label="Phone" value={selected.phone} mono />
                  <DetailRow label="User ID" value={selected.userId} mono />
                  <DetailRow label="Tool" value={selected.toolName} />
                  <DetailRow label="Recipe" value={String(selected.raw.recipeId ?? (selected.raw.metadata as Record<string, unknown> | undefined)?.recipeId ?? '') || undefined} />
                  <DetailRow label="Source agent" value={String(selected.raw.sourceAgent ?? (selected.raw.metadata as Record<string, unknown> | undefined)?.sourceAgent ?? '') || undefined} />
                  <DetailRow label="Created" value={formatDate(selected.createdAt)} />
                  <DetailRow label="Assigned" value={String(selected.raw.assignedTo ?? '') || undefined} mono />
                  <DetailRow label="Recovery" value={String(selected.raw.recoveryAction ?? '') || undefined} />
                </DetailBlock>

                <DetailBlock title="Operator path">
                  <p className="text-sm text-slate-600">
                    {operatorGuidance(selected)}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-4">
                    {selected.targetTab && onNavigate && (
                      <button
                        onClick={() => onNavigate(selected.targetTab!)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <ExternalLink className="w-4 h-4" />
                        Open {selected.targetTab.replace(/_/g, ' ')}
                      </button>
                    )}
                    {onNavigate && (
                      <button
                        onClick={() => onNavigate('messages')}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <MessageSquare className="w-4 h-4" />
                        Messages
                      </button>
                    )}
                  </div>
                </DetailBlock>
              </div>

              {(selected.kind === 'failed_action' || selected.kind === 'pending_approval') && (
                <DetailBlock title="Recovery actions">
                  <div className="space-y-3">
                    <p className="text-xs text-slate-500">
                      These controls <strong>execute on the backend</strong> through admin-gated callables — they really do
                      retry failed Linq deliveries, replay pending actions, and cancel approvals. <strong>Retries and replays
                      run for real</strong> (re-sending messages / re-running tools), high-risk replays (e.g. healthcare portal
                      actions) require the explicit confirmation box below, every attempt is idempotency-keyed against
                      double-execution, and a failed retry stays failed and raises a fresh admin alert rather than reporting
                      success. <strong>Cancelling a pending approval never runs the underlying tool.</strong> Every action here
                      is audit-logged to the operator.
                    </p>
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-500 uppercase">Operator note</span>
                      <textarea
                        value={operatorNote}
                        onChange={(event) => setOperatorNote(event.target.value)}
                        rows={3}
                        placeholder={selected.kind === 'pending_approval' ? 'Why are you cancelling this approval? (required to cancel)' : 'What was checked before retry? (optional)'}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                      />
                    </label>

                    {selected.kind === 'failed_action' && (
                      <>
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-500 uppercase">Recovery owner (optional)</span>
                          <input
                            value={recoveryOwner}
                            onChange={(event) => setRecoveryOwner(event.target.value)}
                            placeholder="Name/label of the operator who owns this"
                            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-500 uppercase">Handled reason (required to mark complete)</span>
                          <textarea
                            value={handledReason}
                            onChange={(event) => setHandledReason(event.target.value)}
                            rows={2}
                            placeholder="What was verified or resolved?"
                            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                          />
                        </label>
                      </>
                    )}

                    {selected.kind === 'pending_approval' && isHighRiskReplay(selected) && (
                      <label className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={highRiskConfirm}
                          onChange={(event) => setHighRiskConfirm(event.target.checked)}
                          className="mt-0.5"
                        />
                        <span className="text-xs text-red-700">
                          <strong>High-risk replay.</strong> This re-runs a real healthcare/portal action. I confirm I want to
                          execute it again.
                        </span>
                      </label>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {selected.kind === 'failed_action' && (
                        <>
                          <button
                            onClick={() => assignSelectedAction(selected)}
                            disabled={busyAction === `assign:${rawId(selected)}`}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            <UserCheck className="w-4 h-4" />
                            {busyAction === `assign:${rawId(selected)}` ? 'Assigning...' : 'Assign owner'}
                          </button>
                          <button
                            onClick={() => requestRetryForSelectedAction(selected)}
                            disabled={busyAction === `retry:${rawId(selected)}`}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
                          >
                            <RotateCcw className="w-4 h-4" />
                            {busyAction === `retry:${rawId(selected)}` ? 'Retrying...' : selected.category === 'linq' ? 'Retry delivery' : 'Retry action'}
                          </button>
                          <button
                            onClick={() => markSelectedActionHandled(selected)}
                            disabled={busyAction === `handled:${rawId(selected)}`}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                          >
                            <Check className="w-4 h-4" />
                            {busyAction === `handled:${rawId(selected)}` ? 'Saving...' : 'Mark recovery complete'}
                          </button>
                        </>
                      )}

                      {selected.kind === 'pending_approval' && (
                        <>
                          <button
                            onClick={() => replaySelectedPendingAction(selected)}
                            disabled={busyAction === `replay:${rawId(selected)}` || (isHighRiskReplay(selected) && !highRiskConfirm)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
                          >
                            <RotateCcw className="w-4 h-4" />
                            {busyAction === `replay:${rawId(selected)}` ? 'Replaying...' : 'Replay action'}
                          </button>
                          <button
                            onClick={() => cancelSelectedPendingAction(selected)}
                            disabled={busyAction === `cancel:${rawId(selected)}`}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            <XCircle className="w-4 h-4" />
                            {busyAction === `cancel:${rawId(selected)}` ? 'Cancelling...' : 'Cancel approval'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </DetailBlock>
              )}

              <DetailBlock title="Raw context">
                <pre className="text-xs bg-slate-950 text-slate-100 rounded-lg p-4 overflow-x-auto max-h-[420px]">
                  {JSON.stringify(selected.raw, null, 2)}
                </pre>
              </DetailBlock>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number; icon: React.ReactNode; tone?: 'default' | 'danger' | 'warning' }> = ({
  label,
  value,
  icon,
  tone = 'default',
}) => {
  const toneClass = tone === 'danger'
    ? 'text-red-700 bg-red-50 border-red-100'
    : tone === 'warning'
      ? 'text-amber-700 bg-amber-50 border-amber-100'
      : 'text-primary-700 bg-primary-50 border-primary-100';
  return (
    <div className={`border rounded-lg p-3 ${toneClass}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold mt-2">{value}</div>
    </div>
  );
};

const DetailBlock: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="bg-white border border-slate-200 rounded-lg p-5">
    <h4 className="text-sm font-semibold text-slate-900 mb-3">{title}</h4>
    {children}
  </section>
);

const DetailRow: React.FC<{ label: string; value?: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-start justify-between gap-4 py-2 border-b border-slate-100 last:border-0">
    <span className="text-xs font-medium text-slate-500">{label}</span>
    <span className={`text-sm text-slate-800 text-right ${mono ? 'font-mono' : ''}`}>{value || '-'}</span>
  </div>
);

function operatorGuidance(item: QueueItem): string {
  if (item.kind === 'pending_approval') {
    return item.status === 'expired-awaiting'
      ? 'The confirmation window expired. Review the original request before asking the family to confirm again.'
      : 'This action is waiting on explicit confirmation or is currently executing. Do not manually mark it complete unless the downstream action is verified.';
  }
  if (item.kind === 'failed_action') {
    if (item.category === 'healthcare') return 'Healthcare action failed after approval. Check the browser/session trail and contact the account holder before retrying.';
    if (item.category === 'payments') return 'Payment-related action failed. Check shift hours, invoice, Stripe state, and avoid duplicate charges before retrying.';
    if (item.category === 'recipes') return 'Recipe or family-group handoff failed. Check the ledger metadata, Linq delivery state, and family group membership before retrying.';
    return 'Review the tool failure, related alert, and user thread. Retry only when idempotency is clear.';
  }
  if (item.kind === 'support_ticket') return 'Support ticket needs human follow-up. Use the Support tab to respond and update status.';
  if (item.kind === 'draft') return 'Cara draft requires review or retry. Use Cara Drafts to edit, approve, reject, or send.';
  if (item.kind === 'quality_issue') return 'Conversation quality signal. Review recent messages and tool activity, then decide whether a prompt, routing, or operator follow-up fix is needed.';
  if (item.category === 'linq') return 'Delivery issue. Confirm Linq health, retry state, and whether SMS fallback already happened.';
  if (item.category === 'qa') return 'Cara runtime issue. Review the alert detail, recent messages, and action ledger before marking resolved.';
  if (item.category === 'recipes') return 'Recipe handoff issue. Confirm the user-visible state, related ledger row, and whether retry would duplicate a message or group add.';
  return 'Review the raw context, resolve the source issue, then mark the alert resolved.';
}

export default AdminCaraControlRoom;
