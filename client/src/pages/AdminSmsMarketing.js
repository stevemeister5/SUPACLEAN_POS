import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast';
import Loader from '../components/Loader';
import { Button, EmptyState, PageHeader, StatusBadge, SurfaceCard } from '../components/ui';
import './AdminSmsMarketing.css';

const PLACEHOLDER_CUSTOMER = '{{customer_name}}';
const PLACEHOLDER_NAME = '{{name}}';
const SMS_SOFT_LIMIT = 160;

function formatBool(b) {
  return b === true || b === 'true' || b === 1 || b === '1';
}

function isTemplateActive(tpl) {
  return tpl?.is_active === 1 || tpl?.is_active === true;
}

const AdminSmsMarketing = () => {
  const { isAdmin } = useAuth();
  const { showToast, ToastContainer } = useToast();
  const messageRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [smsSendingEnabled, setSmsSendingEnabled] = useState(true);
  const [syncSaving, setSyncSaving] = useState(false);

  const [templates, setTemplates] = useState([]);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const [templateName, setTemplateName] = useState('');
  const [templateMessage, setTemplateMessage] = useState('');
  const [templateIsActive, setTemplateIsActive] = useState(true);
  const [editingTemplateId, setEditingTemplateId] = useState(null);

  const [campaignName, setCampaignName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [audienceAll, setAudienceAll] = useState(true);
  const [tagsCsv, setTagsCsv] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [limit, setLimit] = useState(200);
  const [sending, setSending] = useState(false);
  const [lastSendResult, setLastSendResult] = useState(null);

  const activeTemplates = useMemo(
    () => (templates || []).filter(isTemplateActive),
    [templates]
  );

  const messageLength = templateMessage.length;
  const overSmsLimit = messageLength > SMS_SOFT_LIMIT;

  const loadAll = async () => {
    setLoading(true);
    try {
      const [statusRes, templatesRes] = await Promise.all([
        api.get('/admin/sms-marketing/status'),
        api.get('/admin/sms-marketing/templates'),
      ]);
      setSmsSendingEnabled(formatBool(statusRes?.data?.smsSendingEnabled));
      const list = Array.isArray(templatesRes?.data) ? templatesRes.data : [];
      setTemplates(list);

      const firstActive = list.find(isTemplateActive);
      setTemplateId((current) => current || (firstActive?.id ? String(firstActive.id) : ''));
    } catch (err) {
      console.error(err);
      showToast(err?.response?.data?.error || err.message || 'Failed to load SMS marketing', 'warning');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isAdmin) return;
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const handleToggleGlobalSms = async () => {
    const nextEnabled = !smsSendingEnabled;
    const confirmMsg = nextEnabled
      ? 'Turn SMS sending back on for customers?'
      : 'Disable all SMS to customers? Receipts, reminders, and marketing will stop until you enable it again.';
    if (!window.confirm(confirmMsg)) return;

    try {
      setSyncSaving(true);
      await api.put('/admin/sms-marketing/suppress', { enabled: nextEnabled });
      const statusRes = await api.get('/admin/sms-marketing/status');
      setSmsSendingEnabled(formatBool(statusRes?.data?.smsSendingEnabled));
      showToast(nextEnabled ? 'SMS sending is on' : 'SMS sending is off');
    } catch (err) {
      console.error(err);
      showToast(err?.response?.data?.error || err.message || 'Failed to update SMS switch', 'warning');
    } finally {
      setSyncSaving(false);
    }
  };

  const resetTemplateForm = () => {
    setEditingTemplateId(null);
    setTemplateName('');
    setTemplateMessage('');
    setTemplateIsActive(true);
  };

  const insertPlaceholder = (token) => {
    const el = messageRef.current;
    if (!el) {
      setTemplateMessage((prev) => `${prev}${token}`);
      return;
    }
    const start = el.selectionStart ?? templateMessage.length;
    const end = el.selectionEnd ?? templateMessage.length;
    const next = `${templateMessage.slice(0, start)}${token}${templateMessage.slice(end)}`;
    setTemplateMessage(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const handleEditTemplate = (tpl) => {
    setEditingTemplateId(String(tpl.id));
    setTemplateName(tpl.name || '');
    setTemplateMessage(tpl.message || '');
    setTemplateIsActive(isTemplateActive(tpl));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSaveTemplate = async (e) => {
    e.preventDefault();
    const name = templateName.trim();
    const message = templateMessage.trim();
    if (!name || !message) {
      showToast('Template name and message are required', 'warning');
      return;
    }
    try {
      setSavingTemplate(true);
      if (editingTemplateId) {
        await api.put(`/admin/sms-marketing/templates/${editingTemplateId}`, {
          name,
          message,
          is_active: templateIsActive,
        });
        showToast('Template updated');
      } else {
        await api.post('/admin/sms-marketing/templates', {
          name,
          message,
          is_active: templateIsActive,
        });
        showToast('Template created');
      }
      resetTemplateForm();
      await loadAll();
    } catch (err) {
      console.error(err);
      showToast(err?.response?.data?.error || err.message || 'Failed to save template', 'warning');
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleActivateTemplate = async (tpl, active) => {
    try {
      setSavingTemplate(true);
      await api.put(`/admin/sms-marketing/templates/${tpl.id}`, { is_active: active });
      showToast(active ? 'Template is available for campaigns' : 'Template hidden from campaigns');
      await loadAll();
    } catch (err) {
      console.error(err);
      showToast(err?.response?.data?.error || err.message || 'Failed to update template', 'warning');
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleSendCampaign = async (e) => {
    e.preventDefault();
    if (!templateId) {
      showToast('Create and activate a template first', 'warning');
      return;
    }
    if (!audienceAll && !tagsCsv.trim()) {
      showToast('Enter at least one customer tag, or choose all customers', 'warning');
      return;
    }
    if (!smsSendingEnabled && !dryRun) {
      showToast('SMS sending is off. Enable it before sending a live campaign.', 'warning');
      return;
    }
    if (!dryRun) {
      const ok = window.confirm(
        'This will send real SMS messages to customers. Continue?'
      );
      if (!ok) return;
    }

    try {
      setSending(true);
      setLastSendResult(null);
      const tags = tagsCsv
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const payload = {
        name: campaignName.trim() || 'SMS marketing campaign',
        template_id: templateId,
        audience_all: audienceAll,
        tags,
        dry_run: dryRun,
        limit: Number(limit) || 200,
      };

      const res = await api.post('/admin/sms-marketing/send', payload);
      setLastSendResult(res?.data || null);
      showToast(dryRun ? 'Preview complete — no messages sent' : 'Campaign finished');
    } catch (err) {
      console.error(err);
      showToast(err?.response?.data?.error || err.message || 'Campaign send failed', 'warning');
    } finally {
      setSending(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="admin-sms">
        <EmptyState
          title="Access denied"
          description="Only admins can manage SMS sending and marketing campaigns."
        />
      </div>
    );
  }

  if (loading) return <Loader message="Loading SMS marketing…" fullPage delayMs={0} />;

  return (
    <div className="admin-sms">
      <ToastContainer />
      <PageHeader
        title="SMS Marketing"
        subtitle="Turn customer SMS on or off, write reusable message templates, then send a campaign to all customers or a tagged group."
      />

      <SurfaceCard className="sms-status-card">
        <div className="sms-status-row">
          <div className="sms-status-copy">
            <p className="sms-status-kicker">Customer SMS</p>
            <StatusBadge tone={smsSendingEnabled ? 'success' : 'danger'}>
              {smsSendingEnabled ? 'Sending on' : 'Sending off'}
            </StatusBadge>
            <p>
              {smsSendingEnabled
                ? 'Receipts, reminders, and marketing SMS can go out to customers.'
                : 'No SMS will be sent to customers until you turn this back on. This includes receipts and reminders.'}
            </p>
          </div>
          <Button
            variant={smsSendingEnabled ? 'danger' : 'success'}
            disabled={syncSaving}
            onClick={handleToggleGlobalSms}
          >
            {syncSaving ? 'Saving…' : smsSendingEnabled ? 'Turn SMS off' : 'Turn SMS on'}
          </Button>
        </div>
      </SurfaceCard>

      <div className="sms-grid">
        <SurfaceCard title="Templates">
          {templates.length === 0 ? (
            <EmptyState
              title="No templates yet"
              description="Write a message on the right, then save it. Campaigns can only use active templates."
            />
          ) : (
            <ul className="sms-template-list">
              {templates.map((tpl) => (
                <li
                  key={tpl.id}
                  className={`sms-template-item${isTemplateActive(tpl) ? '' : ' inactive'}`}
                >
                  <div className="sms-template-meta">
                    <div className="sms-template-title">
                      <strong>{tpl.name}</strong>
                      <StatusBadge tone={isTemplateActive(tpl) ? 'success' : 'neutral'}>
                        {isTemplateActive(tpl) ? 'Active' : 'Inactive'}
                      </StatusBadge>
                    </div>
                    <p className="sms-template-preview">
                      {String(tpl.message || '').slice(0, 120)}
                      {String(tpl.message || '').length > 120 ? '…' : ''}
                    </p>
                  </div>
                  <div className="sms-template-actions">
                    <Button size="sm" variant="secondary" onClick={() => handleEditTemplate(tpl)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant={isTemplateActive(tpl) ? 'secondary' : 'success'}
                      onClick={() => handleActivateTemplate(tpl, !isTemplateActive(tpl))}
                    >
                      {isTemplateActive(tpl) ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SurfaceCard>

        <SurfaceCard title={editingTemplateId ? 'Edit template' : 'New template'}>
          <form onSubmit={handleSaveTemplate}>
            <div className="sms-form-grid">
              <div className="form-group full">
                <label htmlFor="sms-template-name">Template name</label>
                <input
                  id="sms-template-name"
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="e.g. Weekend offer"
                />
              </div>
              <div className="form-group full">
                <label htmlFor="sms-template-message">Message</label>
                <textarea
                  id="sms-template-message"
                  ref={messageRef}
                  value={templateMessage}
                  onChange={(e) => setTemplateMessage(e.target.value)}
                  placeholder="Habari, asante kwa kutumia SUPACLEAN…"
                  rows={7}
                />
                <div className="placeholder-chips">
                  <button
                    type="button"
                    className="placeholder-chip"
                    onClick={() => insertPlaceholder(PLACEHOLDER_CUSTOMER)}
                  >
                    {PLACEHOLDER_CUSTOMER}
                  </button>
                  <button
                    type="button"
                    className="placeholder-chip"
                    onClick={() => insertPlaceholder(PLACEHOLDER_NAME)}
                  >
                    {PLACEHOLDER_NAME}
                  </button>
                </div>
                <p className={`form-hint${overSmsLimit ? ' warn' : ''}`}>
                  {messageLength} characters
                  {overSmsLimit
                    ? ` — over ${SMS_SOFT_LIMIT}, this may send as more than one SMS.`
                    : ` — keep under ${SMS_SOFT_LIMIT} for a single SMS.`}
                </p>
              </div>
              <div className="form-group full">
                <label className="sms-checkbox">
                  <input
                    type="checkbox"
                    checked={templateIsActive}
                    onChange={(e) => setTemplateIsActive(e.target.checked)}
                  />
                  <span>Active — available when sending a campaign</span>
                </label>
              </div>
            </div>
            <div className="sms-form-actions">
              <Button type="submit" variant="primary" disabled={savingTemplate}>
                {savingTemplate ? 'Saving…' : editingTemplateId ? 'Save changes' : 'Save template'}
              </Button>
              {editingTemplateId && (
                <Button variant="secondary" disabled={savingTemplate} onClick={resetTemplateForm}>
                  Cancel edit
                </Button>
              )}
            </div>
          </form>
        </SurfaceCard>
      </div>

      <SurfaceCard title="Send campaign" className="sms-campaign-card">
        <form onSubmit={handleSendCampaign}>
          <div className="sms-form-grid">
            <div className="form-group">
              <label htmlFor="sms-campaign-name">Campaign name</label>
              <input
                id="sms-campaign-name"
                type="text"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="e.g. Easter promo"
              />
            </div>
            <div className="form-group">
              <label htmlFor="sms-campaign-template">Template</label>
              <select
                id="sms-campaign-template"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={activeTemplates.length === 0}
              >
                {activeTemplates.length === 0 ? (
                  <option value="">No active templates</option>
                ) : (
                  activeTemplates.map((t) => (
                    <option key={t.id} value={String(t.id)}>
                      {t.name}
                    </option>
                  ))
                )}
              </select>
              {activeTemplates.length === 0 && (
                <p className="form-hint">Save an active template above before sending.</p>
              )}
            </div>
            <div className="form-group">
              <span className="field-label">Who should receive it?</span>
              <div className="sms-audience">
                <label className="sms-radio">
                  <input
                    type="radio"
                    name="sms-audience"
                    checked={audienceAll}
                    onChange={() => setAudienceAll(true)}
                  />
                  <span>All customers with SMS enabled</span>
                </label>
                <label className="sms-radio">
                  <input
                    type="radio"
                    name="sms-audience"
                    checked={!audienceAll}
                    onChange={() => setAudienceAll(false)}
                  />
                  <span>Only customers with these tags</span>
                </label>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="sms-campaign-tags">Tags</label>
              <input
                id="sms-campaign-tags"
                type="text"
                value={tagsCsv}
                onChange={(e) => setTagsCsv(e.target.value)}
                placeholder="VIP, Regular"
                disabled={audienceAll}
              />
              <p className="form-hint">Separate tags with commas. Used only when “tags” is selected.</p>
            </div>
            <div className="form-group">
              <label htmlFor="sms-campaign-limit">Maximum recipients</label>
              <input
                id="sms-campaign-limit"
                type="number"
                inputMode="numeric"
                min={1}
                max={500}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
              <p className="form-hint">Up to 500 per send.</p>
            </div>
            <div className="form-group">
              <label className="sms-checkbox">
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(e) => setDryRun(e.target.checked)}
                />
                <span>Preview only — count recipients, do not send</span>
              </label>
            </div>
            <div className="form-group full">
              {dryRun ? (
                <div className="sms-warning-box">
                  Preview is on. You will see how many customers match, and no SMS will be sent.
                </div>
              ) : (
                <div className="sms-warning-box danger">
                  Live send is on. Matching customers will receive a real SMS.
                  {!smsSendingEnabled ? ' Customer SMS is currently off, so a live send will be blocked.' : ''}
                </div>
              )}
            </div>
          </div>
          <div className="sms-form-actions">
            <Button type="submit" variant={dryRun ? 'secondary' : 'primary'} disabled={sending || !templateId}>
              {sending ? 'Working…' : dryRun ? 'Preview campaign' : 'Send campaign'}
            </Button>
          </div>
        </form>
      </SurfaceCard>

      {lastSendResult && (
        <SurfaceCard title={lastSendResult.dry_run ? 'Preview result' : 'Send result'}>
          <div className="sms-result-grid">
            <div className="sms-result-stat">
              <span>Matched</span>
              <strong>{lastSendResult.recipient_count ?? 0}</strong>
            </div>
            {!lastSendResult.dry_run && (
              <>
                <div className="sms-result-stat">
                  <span>Sent</span>
                  <strong>{lastSendResult.sent_count ?? 0}</strong>
                </div>
                <div className="sms-result-stat">
                  <span>Skipped</span>
                  <strong>{lastSendResult.skipped_duplicate_count ?? 0}</strong>
                </div>
                <div className="sms-result-stat">
                  <span>Suppressed</span>
                  <strong>{lastSendResult.suppressed_count ?? 0}</strong>
                </div>
                <div className="sms-result-stat">
                  <span>Failed</span>
                  <strong>{lastSendResult.failed_count ?? 0}</strong>
                </div>
              </>
            )}
          </div>
        </SurfaceCard>
      )}
    </div>
  );
};

export default AdminSmsMarketing;
