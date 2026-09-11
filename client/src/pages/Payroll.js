import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createPayrollEmployee,
  getMonthlyPayroll,
  getPayrollEmployees,
  getPayrollHistory,
  getSavedMonthlyPayroll,
  getSalaryAdvances,
  getBranchFeatures,
  reopenPayrollMonth,
  saveMonthlyPayroll,
  updatePayrollEmployee
} from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import useHorizontalScrollRegion from '../hooks/useHorizontalScrollRegion';
import './Payroll.css';

const monthNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const formatPayrollMonthLabel = (monthKey) => {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(String(monthKey))) return monthKey || '—';
  const [y, m] = String(monthKey).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
};

const moneyTzs = (n) => `TSh ${Number(n || 0).toLocaleString()}`;

/** Net still on the books while the period is open (matches API when present). */
const outstandingNetForHistoryRow = (h) => {
  if (h == null) return 0;
  if (h.outstanding_net_pay != null && Number.isFinite(Number(h.outstanding_net_pay))) {
    return Number(h.outstanding_net_pay);
  }
  return String(h.payroll_status) === 'Open' ? Number(h.total_net_salary || 0) : 0;
};

const sumPayrollLines = (lines) => {
  const list = lines || [];
  let totalGross = 0;
  let totalNet = 0;
  for (const line of list) {
    totalGross += Number(line.gross_salary || 0) + Number(line.allowances || 0) + Number(line.bonuses || 0);
    totalNet += Number(line.net_salary || 0);
  }
  return { employee_count: list.length, total_gross: totalGross, total_net: totalNet };
};

const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const estimateMonthlyPAYE = (x) => {
  const income = Math.max(0, Number(x || 0));
  // Tanzania monthly resident employment PAYE bands.
  if (income <= 270000) return 0;
  if (income <= 520000) return (income - 270000) * 0.08;
  if (income <= 760000) return 20000 + (income - 520000) * 0.2;
  if (income <= 1000000) return 68000 + (income - 760000) * 0.25;
  return 128000 + (income - 1000000) * 0.3;
};

const clampRate = (v, fallback = 10) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
};

const isFeatureEnabled = (value) => value === true || value === 1 || value === '1' || value === 't';

const Payroll = () => {
  const { hasPermission, isAdmin, user, branch } = useAuth();
  const { showToast, ToastContainer } = useToast();
  const canManagePayroll = hasPermission('canManagePayroll');
  const canRecordAdvances = hasPermission('canRecordSalaryAdvances');
  const [payrollFeatureEnabled, setPayrollFeatureEnabled] = useState(isAdmin ? true : null);
  const [activeStep, setActiveStep] = useState(canManagePayroll ? 'payrun' : 'staff');
  const [monthKey, setMonthKey] = useState(monthNow());
  const [employees, setEmployees] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [payroll, setPayroll] = useState([]);
  const [payrollHistory, setPayrollHistory] = useState([]);
  const [hasSavedSnapshot, setHasSavedSnapshot] = useState(false);
  const [selectedEmployeeStatement, setSelectedEmployeeStatement] = useState('');
  const [staffSearch, setStaffSearch] = useState('');
  const [editingStaffId, setEditingStaffId] = useState(null);
  const [staffDraft, setStaffDraft] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [savingStaff, setSavingStaff] = useState(false);
  const [periodStatus, setPeriodStatus] = useState('open');
  const [completedOn, setCompletedOn] = useState('');
  const [markCompleted, setMarkCompleted] = useState(false);
  const tableScrollHandlers = useHorizontalScrollRegion();
  const verificationWrapRef = useRef(null);

  const [employeeForm, setEmployeeForm] = useState({
    full_name: '',
    employee_code: '',
    phone: '',
    gross_salary: '',
    default_allowances: '',
    default_bonuses: '',
    default_other_deductions: '',
    nssf_enabled: true,
    nssf_employee_rate: '10',
    nssf_employer_rate: '10',
    paye_enabled: true
  });

  const recomputeLine = (line) => {
    const gross = Number(line.gross_salary || 0);
    const allowances = Number(line.allowances || 0);
    const bonuses = Number(line.bonuses || 0);
    const advancesAmt = Number(line.salary_advances || 0);
    const other = Number(line.other_deductions || 0);
    const nssfEnabled = line.nssf_enabled !== false;
    const payeEnabled = line.paye_enabled !== false;
    const nssfEmployeeRate = clampRate(line.nssf_employee_rate, 10);
    const nssfEmployerRate = clampRate(line.nssf_employer_rate, 10);
    const nssfEmployeeAmount = nssfEnabled ? (gross * nssfEmployeeRate) / 100 : 0;
    const nssfEmployerAmount = nssfEnabled ? (gross * nssfEmployerRate) / 100 : 0;
    const taxableIncome = Math.max(0, gross + allowances + bonuses - nssfEmployeeAmount);
    const paye = payeEnabled ? estimateMonthlyPAYE(taxableIncome) : 0;
    const total = nssfEmployeeAmount + paye + advancesAmt + other;
    return {
      ...line,
      nssf_employee_rate: nssfEmployeeRate,
      nssf_employer_rate: nssfEmployerRate,
      nssf_amount: nssfEmployeeAmount,
      employer_nssf_amount: nssfEmployerAmount,
      taxable_income: taxableIncome,
      paye_estimate: paye,
      total_deductions: total,
      net_salary: gross + allowances + bonuses - total,
      total_employer_cost: gross + allowances + bonuses + nssfEmployerAmount
    };
  };

  const load = async () => {
    if (!payrollFeatureEnabled || (!canManagePayroll && !canRecordAdvances)) return;
    setLoading(true);
    try {
      const calls = [];
      if (canManagePayroll) calls.push(getPayrollEmployees(), getMonthlyPayroll(monthKey), getPayrollHistory({ limit: 48 }));
      if (canRecordAdvances) calls.push(getSalaryAdvances({ month: monthKey }));
      const results = await Promise.all(calls);
      let idx = 0;
      if (canManagePayroll) {
        setEmployees(results[idx++].data || []);
        const monthlyRes = results[idx++];
        const monthlyData = monthlyRes.data || {};
        setPayroll((monthlyData.lines || []).map((line) => ({ ...line })));
        setHasSavedSnapshot(!!monthlyData.has_saved_snapshot);
        const p = monthlyData.period;
        setPeriodStatus(p?.status === 'closed' ? 'closed' : 'open');
        setCompletedOn(p?.completed_on ? String(p.completed_on).slice(0, 10) : '');
        setMarkCompleted(false);
        const h = results[idx++].data || [];
        setPayrollHistory(h);
      }
      if (canRecordAdvances) {
        setAdvances(results[idx++].data || []);
      }
    } catch (err) {
      showToast(`Error loading payroll: ${err.response?.data?.error || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      setPayrollFeatureEnabled(true);
      return;
    }
    const branchId = user?.branchId ?? branch?.id;
    if (!branchId) {
      setPayrollFeatureEnabled(false);
      return;
    }
    let cancelled = false;
    getBranchFeatures(branchId)
      .then((res) => {
        if (cancelled) return;
        const enabled = (res.data || []).some(
          (f) => f.feature_key === 'payroll' && isFeatureEnabled(f.is_enabled)
        );
        setPayrollFeatureEnabled(enabled);
      })
      .catch(() => {
        if (!cancelled) setPayrollFeatureEnabled(false);
      });
    return () => { cancelled = true; };
  }, [isAdmin, user?.branchId, branch?.id]);

  useEffect(() => {
    load();
  }, [monthKey, canManagePayroll, canRecordAdvances, payrollFeatureEnabled]);

  const employeeOptions = useMemo(() => employees.map((e) => ({ id: e.id, name: e.full_name })), [employees]);
  const filteredEmployees = useMemo(() => {
    const q = String(staffSearch || '').trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => {
      const fullName = String(e.full_name || '').toLowerCase();
      const code = String(e.employee_code || '').toLowerCase();
      const phone = String(e.phone || '').toLowerCase();
      return fullName.includes(q) || code.includes(q) || phone.includes(q);
    });
  }, [employees, staffSearch]);
  const totalEmployees = employees.filter((e) => e.is_active !== false).length;
  const payrollTotals = useMemo(() => sumPayrollLines(payroll), [payroll]);
  const savedHistoryEntry = useMemo(
    () => payrollHistory.find((h) => h.month_key === monthKey) || null,
    [payrollHistory, monthKey]
  );
  const totalsMatchSaved = savedHistoryEntry
    ? Math.abs(Number(savedHistoryEntry.total_net_salary || 0) - payrollTotals.total_net) < 1
      && Math.abs(Number(savedHistoryEntry.total_gross_compensation || 0) - payrollTotals.total_gross) < 1
      && Number(savedHistoryEntry.processed_employees || 0) === payrollTotals.employee_count
    : !hasSavedSnapshot;
  const advancesTotal = advances.reduce((sum, a) => sum + Number(a.amount || 0), 0);

  const submitEmployee = async (e) => {
    e.preventDefault();
    try {
      await createPayrollEmployee({
        ...employeeForm,
        tin_number: employeeForm.employee_code || null,
        gross_salary: Number(employeeForm.gross_salary || 0),
        default_allowances: Number(employeeForm.default_allowances || 0),
        default_bonuses: Number(employeeForm.default_bonuses || 0),
        default_other_deductions: Number(employeeForm.default_other_deductions || 0),
        nssf_employee_rate: clampRate(employeeForm.nssf_employee_rate, 10),
        nssf_employer_rate: clampRate(employeeForm.nssf_employer_rate, 10)
      });
      showToast('Employee added', 'success');
      setEmployeeForm({
        full_name: '',
        employee_code: '',
        phone: '',
        gross_salary: '',
        default_allowances: '',
        default_bonuses: '',
        default_other_deductions: '',
        nssf_enabled: true,
        nssf_employee_rate: '10',
        nssf_employer_rate: '10',
        paye_enabled: true
      });
      load();
    } catch (err) {
      showToast(`Error adding employee: ${err.response?.data?.error || err.message}`, 'error');
    }
  };

  const startEditStaff = (emp) => {
    setEditingStaffId(emp.id);
    setStaffDraft({
      full_name: emp.full_name || '',
      employee_code: emp.employee_code || '',
      phone: emp.phone || '',
      gross_salary: Number(emp.gross_salary || 0),
      nssf_enabled: !!emp.nssf_enabled,
      paye_enabled: !!emp.paye_enabled,
      is_active: !!emp.is_active
    });
  };

  const cancelEditStaff = () => {
    setEditingStaffId(null);
    setStaffDraft({});
  };

  const saveEditStaff = async () => {
    if (!editingStaffId) return;
    setSavingStaff(true);
    try {
      await updatePayrollEmployee(editingStaffId, {
        ...staffDraft,
        tin_number: staffDraft.employee_code || null
      });
      showToast('Staff details updated', 'success');
      cancelEditStaff();
      load();
    } catch (err) {
      showToast(`Error updating staff: ${err.response?.data?.error || err.message}`, 'error');
    } finally {
      setSavingStaff(false);
    }
  };

  const savePayroll = async () => {
    if (periodStatus === 'closed') return;
    if (markCompleted && !completedOn) {
      showToast('Choose the payroll completion date before saving as closed', 'error');
      return;
    }
    setSaving(true);
    try {
      await saveMonthlyPayroll({
        month_key: monthKey,
        lines: payroll,
        mark_closed: markCompleted,
        completed_on: markCompleted ? completedOn : undefined
      });
      showToast(markCompleted ? 'Payroll saved and marked closed' : 'Monthly payroll saved', 'success');
      setMarkCompleted(false);
      load();
    } catch (err) {
      showToast(`Error saving payroll: ${err.response?.data?.error || err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const reopenPayroll = async () => {
    if (periodStatus !== 'closed') return;
    if (!window.confirm('Reopen this payroll month? You can edit figures again; saving will update the stored payroll.')) return;
    setReopening(true);
    try {
      await reopenPayrollMonth(monthKey);
      showToast('Payroll month reopened', 'success');
      load();
    } catch (err) {
      showToast(`Error reopening: ${err.response?.data?.error || err.message}`, 'error');
    } finally {
      setReopening(false);
    }
  };

  const downloadFile = (filename, content, mime = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const actionLoadLines = async () => {
    const res = await getSavedMonthlyPayroll(monthKey);
    const saved = res?.data?.lines || [];
    if (saved.length) return saved;
    return payroll;
  };

  const handleSalaryStatement = async () => {
    try {
      const lines = await actionLoadLines();
      if (!lines.length) return showToast('No saved payroll lines for selected month', 'error');
      const totalNet = lines.reduce((s, r) => s + Number(r.net_salary || 0), 0);
      const totalPaye = lines.reduce((s, r) => s + Number(r.paye_amount || 0), 0);
      const text = [
        `SUPACLEAN Payroll Statement (${monthKey})`,
        `Employees: ${lines.length}`,
        `Total Net: TSh ${totalNet.toLocaleString()}`,
        `Total PAYE: TSh ${totalPaye.toLocaleString()}`,
        '',
        ...lines.map((r) => `${r.full_name} | Gross ${Number(r.gross_salary || 0).toLocaleString()} | Net ${Number(r.net_salary || 0).toLocaleString()}`)
      ].join('\n');
      downloadFile(`payroll-statement-${monthKey}.txt`, text);
      showToast('Salary statement exported', 'success');
    } catch (err) {
      showToast(`Error generating statement: ${err.response?.data?.error || err.message}`, 'error');
    }
  };

  const handleBankTransfer = async () => {
    try {
      const lines = await actionLoadLines();
      if (!lines.length) return showToast('No saved payroll lines for selected month', 'error');
      const csv = [
        'Employee,Employee Code,Net Salary',
        ...lines.map((r) => `"${(r.full_name || '').replace(/"/g, '""')}","${r.employee_code || ''}","${Number(r.net_salary || 0).toFixed(2)}"`)
      ].join('\n');
      downloadFile(`bank-transfer-${monthKey}.csv`, csv, 'text/csv;charset=utf-8');
      showToast('Bank transfer file generated', 'success');
    } catch (err) {
      showToast(`Error generating transfer: ${err.response?.data?.error || err.message}`, 'error');
    }
  };

  const handlePayslips = async () => {
    try {
      const lines = await actionLoadLines();
      if (!lines.length) return showToast('No saved payroll lines for selected month', 'error');
      const slips = lines.map((r) => ([
        '--- PAYSLIP ---',
        `Month: ${monthKey}`,
        `Employee: ${r.full_name}`,
        `Gross: TSh ${Number(r.gross_salary || 0).toLocaleString()}`,
        `Allowances: TSh ${Number(r.allowances || 0).toLocaleString()}`,
        `Bonuses: TSh ${Number(r.bonuses || 0).toLocaleString()}`,
        `Employee NSSF: TSh ${Number(r.nssf_amount || 0).toLocaleString()}`,
        `Employer NSSF: TSh ${Number(r.employer_nssf_amount || 0).toLocaleString()}`,
        `PAYE: TSh ${Number(r.paye_amount || r.paye_estimate || 0).toLocaleString()}`,
        `Advances: TSh ${Number(r.salary_advances || 0).toLocaleString()}`,
        `Other Deductions: TSh ${Number(r.other_deductions || 0).toLocaleString()}`,
        `Net Salary: TSh ${Number(r.net_salary || 0).toLocaleString()}`,
        ''
      ].join('\n'))).join('\n');
      downloadFile(`payslips-${monthKey}.txt`, slips);
      showToast('Payslips exported', 'success');
    } catch (err) {
      showToast(`Error generating payslips: ${err.response?.data?.error || err.message}`, 'error');
    }
  };

  const handlePayrollSpreadsheet = async () => {
    try {
      const lines = await actionLoadLines();
      if (!lines.length) return showToast('No saved payroll lines for selected month', 'error');
      const month = monthKey;
      const ExcelJS = (await import(/* webpackChunkName: "lib-exceljs" */ 'exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Payroll');
      sheet.addRow([
        'Employee',
        'Employee Code',
        'Gross Salary',
        'Allowances',
        'Bonuses',
        'Employee NSSF',
        'Employer NSSF',
        'PAYE',
        'Salary Advances',
        'Other Deductions',
        'Net Salary',
        'Employer Total Cost'
      ]);
      lines.forEach((r) => {
        sheet.addRow([
          r.full_name || '',
          r.employee_code || '',
          Number(r.gross_salary || 0),
          Number(r.allowances || 0),
          Number(r.bonuses || 0),
          Number(r.nssf_amount || 0),
          Number(r.employer_nssf_amount || 0),
          Number(r.paye_amount || r.paye_estimate || 0),
          Number(r.salary_advances || 0),
          Number(r.other_deductions || 0),
          Number(r.net_salary || 0),
          Number(r.total_employer_cost || 0)
        ]);
      });
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll-spreadsheet-${month}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Payroll spreadsheet exported (Excel)', 'success');
    } catch (err) {
      showToast(`Error exporting spreadsheet: ${err.response?.data?.error || err.message}`, 'error');
    }
  };

  const handleEmployeeStatement = async () => {
    try {
      if (!selectedEmployeeStatement) {
        showToast('Select an employee first', 'error');
        return;
      }
      const lines = await actionLoadLines();
      if (!lines.length) return showToast('No saved payroll lines for selected month', 'error');
      const line = lines.find((r) => String(r.employee_id) === String(selectedEmployeeStatement));
      if (!line) return showToast('No payroll line for selected employee in this month', 'error');
      const month = monthKey;
      const employeeAdvances = advances.filter(
        (a) => String(a.employee_id) === String(selectedEmployeeStatement)
      );
      const text = [
        `SUPACLEAN Employee Salary Statement (${month})`,
        `Employee: ${line.full_name}`,
        `Employee Code: ${line.employee_code || '-'}`,
        '',
        `Gross Salary: TSh ${Number(line.gross_salary || 0).toLocaleString()}`,
        `Allowances: TSh ${Number(line.allowances || 0).toLocaleString()}`,
        `Bonuses: TSh ${Number(line.bonuses || 0).toLocaleString()}`,
        `Employee NSSF: TSh ${Number(line.nssf_amount || 0).toLocaleString()}`,
        `Employer NSSF: TSh ${Number(line.employer_nssf_amount || 0).toLocaleString()}`,
        `PAYE: TSh ${Number(line.paye_amount || line.paye_estimate || 0).toLocaleString()}`,
        `Salary Advances: TSh ${Number(line.salary_advances || 0).toLocaleString()}`,
        `Other Deductions: TSh ${Number(line.other_deductions || 0).toLocaleString()}`,
        `Net Salary: TSh ${Number(line.net_salary || 0).toLocaleString()}`,
        '',
        'Advances Detail:',
        ...(employeeAdvances.length
          ? employeeAdvances.map((a) => `- ${a.advance_date}: TSh ${Number(a.amount || 0).toLocaleString()}${a.notes ? ` (${a.notes})` : ''}`)
          : ['- No advances recorded for this month'])
      ].join('\n');
      const safeName = String(line.full_name || 'employee').replace(/\s+/g, '-').toLowerCase();
      downloadFile(`salary-statement-${safeName}-${month}.txt`, text);
      showToast('Employee statement exported', 'success');
    } catch (err) {
      showToast(`Error generating employee statement: ${err.response?.data?.error || err.message}`, 'error');
    }
  };

  const exportStaffDirectory = () => {
    if (!employees.length) {
      showToast('No staff to export', 'error');
      return;
    }
    const csv = [
      'Full Name,Employee Code,Phone,Gross Salary,NSSF,PAYE,Status',
      ...employees.map((e) => [
        `"${String(e.full_name || '').replace(/"/g, '""')}"`,
        `"${String(e.employee_code || '').replace(/"/g, '""')}"`,
        `"${String(e.phone || '').replace(/"/g, '""')}"`,
        Number(e.gross_salary || 0).toFixed(2),
        e.nssf_enabled ? 'Enabled' : 'Disabled',
        e.paye_enabled ? 'Enabled' : 'Disabled',
        e.is_active ? 'Active' : 'Inactive'
      ].join(','))
    ].join('\n');
    downloadFile(`staff-directory-${monthKey}.csv`, csv, 'text/csv;charset=utf-8');
    showToast('Staff directory exported', 'success');
  };

  const updateLineField = (employeeId, key, value, numeric = true) => {
    setPayroll((prev) =>
      prev.map((row) => {
        if (row.employee_id !== employeeId) return row;
        const next = { ...row, [key]: numeric ? Number(value || 0) : value };
        return recomputeLine(next);
      })
    );
  };

  const stopDragBubbling = (e) => e.stopPropagation();

  const scrollVerificationX = (delta) => {
    const el = verificationWrapRef.current;
    if (!el) return;
    el.scrollBy({ left: delta, behavior: 'smooth' });
  };

  if (payrollFeatureEnabled === null) {
    return <div className="page-card"><h2>Payroll</h2><p>Loading…</p></div>;
  }

  if (!payrollFeatureEnabled) {
    return (
      <div className="page-card">
        <h2>Payroll</h2>
        <p>Payroll is not enabled for your branch. Ask an administrator to enable it under Admin → Branches → Privileges.</p>
      </div>
    );
  }

  if (!canManagePayroll && !canRecordAdvances) {
    return <div className="page-card"><h2>Payroll</h2><p>You do not have payroll access.</p></div>;
  }

  return (
    <div className="payroll-page">
      <ToastContainer />
      <div className="payroll-header">
        <div className="payroll-header-text">
          <h1>Payroll</h1>
          <p className="subtitle">Staff, monthly pay run, and saved salary statements</p>
        </div>
        <div className="payroll-header-controls">
          <label className="payroll-control-label">
            Pay period
            <input className="payroll-month-input" type="month" value={monthKey} onChange={(e) => setMonthKey(e.target.value)} />
          </label>
          {canManagePayroll && payrollHistory.length > 0 && (
            <label className="payroll-control-label">
              Saved statement
              <select
                className="payroll-saved-select"
                value={monthKey}
                onChange={(e) => {
                  setMonthKey(e.target.value);
                  setActiveStep('statements');
                }}
              >
                {payrollHistory.map((h) => (
                  <option key={h.month_key} value={h.month_key}>
                    {formatPayrollMonthLabel(h.month_key)} — {h.payroll_status}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="payroll-kpi-grid">
        <div className="payroll-kpi-card payroll-kpi-card--employees">
          <span className="payroll-kpi-label">Total employees</span>
          <span className="payroll-kpi-value">{payrollTotals.employee_count || totalEmployees}</span>
          <span className="payroll-kpi-hint">{formatPayrollMonthLabel(monthKey)}</span>
        </div>
        <div className="payroll-kpi-card payroll-kpi-card--gross">
          <span className="payroll-kpi-label">Total gross pay</span>
          <span className="payroll-kpi-value">{moneyTzs(payrollTotals.total_gross)}</span>
          <span className="payroll-kpi-hint">Gross + allowances + bonuses</span>
        </div>
        <div className="payroll-kpi-card payroll-kpi-card--net">
          <span className="payroll-kpi-label">Total net pay</span>
          <span className="payroll-kpi-value">{moneyTzs(payrollTotals.total_net)}</span>
          <span className="payroll-kpi-hint">After NSSF, PAYE &amp; deductions</span>
        </div>
        <div className="payroll-kpi-card payroll-kpi-card--status">
          <span className="payroll-kpi-label">Period status</span>
          <span className="payroll-kpi-value payroll-kpi-status">
            <span className={`payroll-badge ${periodStatus === 'closed' ? 'closed' : 'open'}`}>
              {loading ? '…' : periodStatus === 'closed' ? 'Closed' : 'Open'}
            </span>
          </span>
          <span className="payroll-kpi-hint">
            {periodStatus === 'closed' && completedOn ? `Completed ${completedOn}` : hasSavedSnapshot ? 'Saved snapshot on file' : 'Draft — save to keep figures'}
          </span>
        </div>
      </div>

      {canManagePayroll && savedHistoryEntry && !totalsMatchSaved && (
        <div className="payroll-sync-banner" role="status">
          Figures on screen differ from the last saved statement for this month. Save payroll to update the stored statement.
        </div>
      )}

      <div className="payroll-steps">
        <button type="button" className={`payroll-step ${activeStep === 'staff' ? 'active' : ''}`} onClick={() => setActiveStep('staff')}>
          Staff directory
        </button>
        {canManagePayroll && (
          <>
            <button type="button" className={`payroll-step ${activeStep === 'payrun' ? 'active' : ''}`} onClick={() => setActiveStep('payrun')}>
              Monthly pay run
            </button>
            <button type="button" className={`payroll-step ${activeStep === 'statements' ? 'active' : ''}`} onClick={() => setActiveStep('statements')}>
              Saved statements
            </button>
          </>
        )}
      </div>

      {canManagePayroll && activeStep === 'staff' && (
        <div className="payroll-card">
          <h3>Add Employee</h3>
          <form onSubmit={submitEmployee} className="payroll-form-grid">
            <input required placeholder="Full name" value={employeeForm.full_name} onChange={(e) => setEmployeeForm({ ...employeeForm, full_name: e.target.value })} />
            <input placeholder="Employee code" value={employeeForm.employee_code} onChange={(e) => setEmployeeForm({ ...employeeForm, employee_code: e.target.value })} />
            <input placeholder="Phone" value={employeeForm.phone} onChange={(e) => setEmployeeForm({ ...employeeForm, phone: e.target.value })} />
            <input type="number" required placeholder="Gross salary" value={employeeForm.gross_salary} onChange={(e) => setEmployeeForm({ ...employeeForm, gross_salary: e.target.value })} inputMode="numeric" />
            <input type="number" placeholder="Allowances" value={employeeForm.default_allowances} onChange={(e) => setEmployeeForm({ ...employeeForm, default_allowances: e.target.value })} inputMode="numeric" />
            <input type="number" placeholder="Bonuses" value={employeeForm.default_bonuses} onChange={(e) => setEmployeeForm({ ...employeeForm, default_bonuses: e.target.value })} inputMode="numeric" />
            <input type="number" placeholder="Other deductions" value={employeeForm.default_other_deductions} onChange={(e) => setEmployeeForm({ ...employeeForm, default_other_deductions: e.target.value })} inputMode="numeric" />
            <div className="payroll-toggle-wrap">
              <label><input type="checkbox" checked={employeeForm.nssf_enabled} onMouseDown={stopDragBubbling} onClick={stopDragBubbling} onChange={(e) => setEmployeeForm({ ...employeeForm, nssf_enabled: e.target.checked })} /> NSSF</label>
              <input type="number" min="0" max="100" step="0.01" placeholder="NSSF employee %" value={employeeForm.nssf_employee_rate} onChange={(e) => setEmployeeForm({ ...employeeForm, nssf_employee_rate: e.target.value })} inputMode="decimal" />
              <input type="number" min="0" max="100" step="0.01" placeholder="NSSF employer %" value={employeeForm.nssf_employer_rate} onChange={(e) => setEmployeeForm({ ...employeeForm, nssf_employer_rate: e.target.value })} inputMode="decimal" />
              <label><input type="checkbox" checked={employeeForm.paye_enabled} onMouseDown={stopDragBubbling} onClick={stopDragBubbling} onChange={(e) => setEmployeeForm({ ...employeeForm, paye_enabled: e.target.checked })} /> PAYE</label>
            </div>
            <button className="btn-primary payroll-submit-btn" type="submit">Add employee</button>
          </form>
        </div>
      )}

      {canManagePayroll && activeStep === 'staff' && (
        <div className="payroll-card">
          <div className="payroll-card-head">
            <h3>All Staff Directory</h3>
            <div className="payroll-staff-controls">
              <input
                className="payroll-search-input"
                type="search"
                placeholder="Search name / code / TIN / phone"
                value={staffSearch}
                onChange={(e) => setStaffSearch(e.target.value)}
                aria-label="Search staff"
              />
              <button type="button" className="payroll-action-btn transfer" onClick={exportStaffDirectory}>
                Export Staff CSV
              </button>
              <span className="payroll-count-chip">{filteredEmployees.length} staff</span>
            </div>
          </div>
          <div
            className="payroll-table-wrap staff-wrap interactive-scroll-region"
            tabIndex={0}
            role="region"
            aria-label="All staff details table"
            {...tableScrollHandlers}
          >
            <table className="payroll-table payroll-table--staff">
              <thead>
                <tr>
                  <th>Full Name</th>
                  <th>Employee Code</th>
                  <th>Phone</th>
                  <th className="num">Gross Salary</th>
                  <th>NSSF</th>
                  <th>PAYE</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.map((emp) => (
                  <tr key={emp.id}>
                    <td>
                      {editingStaffId === emp.id ? (
                        <input
                          type="text"
                          value={staffDraft.full_name || ''}
                          onChange={(e) => setStaffDraft((p) => ({ ...p, full_name: e.target.value }))}
                        />
                      ) : emp.full_name}
                    </td>
                    <td>
                      {editingStaffId === emp.id ? (
                        <input
                          type="text"
                          value={staffDraft.employee_code || ''}
                          onChange={(e) => setStaffDraft((p) => ({ ...p, employee_code: e.target.value }))}
                        />
                      ) : (emp.employee_code || '-')}
                    </td>
                    <td>
                      {editingStaffId === emp.id ? (
                        <input
                          type="text"
                          value={staffDraft.phone || ''}
                          onChange={(e) => setStaffDraft((p) => ({ ...p, phone: e.target.value }))}
                        />
                      ) : (emp.phone || '-')}
                    </td>
                    <td className="num">
                      {editingStaffId === emp.id ? (
                        <input
                          type="number"
                          inputMode="numeric"
                          value={staffDraft.gross_salary ?? 0}
                          onChange={(e) => setStaffDraft((p) => ({ ...p, gross_salary: Number(e.target.value || 0) }))}
                        />
                      ) : Number(emp.gross_salary || 0).toLocaleString()}
                    </td>
                    <td>
                      {editingStaffId === emp.id ? (
                        <input
                          type="checkbox"
                          checked={!!staffDraft.nssf_enabled}
                          onMouseDown={stopDragBubbling}
                          onClick={stopDragBubbling}
                          onChange={(e) => setStaffDraft((p) => ({ ...p, nssf_enabled: e.target.checked }))}
                        />
                      ) : (emp.nssf_enabled ? 'Enabled' : 'Disabled')}
                    </td>
                    <td>
                      {editingStaffId === emp.id ? (
                        <input
                          type="checkbox"
                          checked={!!staffDraft.paye_enabled}
                          onMouseDown={stopDragBubbling}
                          onClick={stopDragBubbling}
                          onChange={(e) => setStaffDraft((p) => ({ ...p, paye_enabled: e.target.checked }))}
                        />
                      ) : (emp.paye_enabled ? 'Enabled' : 'Disabled')}
                    </td>
                    <td>
                      {editingStaffId === emp.id ? (
                        <select
                          value={staffDraft.is_active ? 'active' : 'inactive'}
                          onChange={(e) => setStaffDraft((p) => ({ ...p, is_active: e.target.value === 'active' }))}
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      ) : (emp.is_active ? 'Active' : 'Inactive')}
                    </td>
                    <td>
                      {editingStaffId === emp.id ? (
                        <div className="staff-row-actions">
                          <button type="button" className="btn-primary" disabled={savingStaff} onClick={saveEditStaff}>
                            {savingStaff ? 'Saving...' : 'Save'}
                          </button>
                          <button type="button" className="btn-secondary" onClick={cancelEditStaff}>Cancel</button>
                        </div>
                      ) : (
                        <button type="button" className="btn-secondary" onClick={() => startEditStaff(emp)}>Edit</button>
                      )}
                    </td>
                  </tr>
                ))}
                {employees.length === 0 && (
                  <tr>
                    <td colSpan={9}>{loading ? 'Loading staff...' : 'No staff recorded yet'}</td>
                  </tr>
                )}
                {employees.length > 0 && filteredEmployees.length === 0 && (
                  <tr>
                    <td colSpan={9}>No staff matched your search.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canManagePayroll && activeStep === 'payrun' && (
        <div className="payroll-card">
          <div className="payroll-card-head">
            <h3>Monthly pay run — {formatPayrollMonthLabel(monthKey)}</h3>
            <div className="verification-head-actions">
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={() => scrollVerificationX(-320)}
                title="Scroll left"
              >
                ◀ Left
              </button>
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={() => scrollVerificationX(320)}
                title="Scroll right"
              >
                Right ▶
              </button>
              {periodStatus === 'closed' ? (
                <button type="button" className="btn-secondary" onClick={reopenPayroll} disabled={reopening || loading}>
                  {reopening ? 'Reopening…' : 'Reopen payroll'}
                </button>
              ) : (
                <button className="btn-primary" onClick={savePayroll} disabled={saving || loading}>
                  {saving ? 'Saving…' : markCompleted ? 'Save & close payroll' : 'Save payroll'}
                </button>
              )}
            </div>
          </div>
          {periodStatus === 'closed' && (
            <div className="payroll-period-banner">
              This month is closed and figures are frozen from the last save. Reopen above to change amounts.
            </div>
          )}
          {periodStatus === 'open' && (
            <div className="payroll-close-row">
              <label className="payroll-mark-complete">
                <input
                  type="checkbox"
                  checked={markCompleted}
                  onMouseDown={stopDragBubbling}
                  onClick={stopDragBubbling}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setMarkCompleted(v);
                    if (v && !completedOn) setCompletedOn(todayYmd());
                  }}
                />
                Mark payroll completed (requires completion date)
              </label>
              {markCompleted && (
                <label className="payroll-inline-date">
                  Payroll date
                  <input type="date" value={completedOn} onChange={(e) => setCompletedOn(e.target.value)} />
                </label>
              )}
            </div>
          )}
          <div className="payroll-note">
            Edit amounts below, then save. Saved figures reload exactly for this month until you change them again.
            PAYE uses Tanzania monthly bands after employee NSSF.
          </div>
          <div className="payroll-run-totals" aria-live="polite">
            <span>{payrollTotals.employee_count} employees</span>
            <span>Gross {moneyTzs(payrollTotals.total_gross)}</span>
            <span>Net {moneyTzs(payrollTotals.total_net)}</span>
            <span>Advances {moneyTzs(advancesTotal)}</span>
          </div>
          <div
            className="payroll-table-wrap verification-wrap interactive-scroll-region"
            ref={verificationWrapRef}
            tabIndex={0}
            role="region"
            aria-label="Monthly payroll table"
            {...tableScrollHandlers}
          >
            <table className="payroll-table payroll-table--verification payroll-table--compact">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="num">Gross</th>
                  <th className="num">Bonus</th>
                  <th>NSSF On</th>
                  <th className="num">Emp NSSF</th>
                  <th className="num">Er NSSF</th>
                  <th className="num">Taxable</th>
                  <th>PAYE On</th>
                  <th className="num">PAYE Est.</th>
                  <th className="num">Advances</th>
                  <th className="num">Other Ded.</th>
                  <th className="num">Net</th>
                  <th className="num">Employer Cost</th>
                </tr>
              </thead>
              <tbody>
                {payroll.map((r) => (
                  <tr key={r.employee_id}>
                    <td>{r.full_name}</td>
                    <td className="num"><input type="number" disabled={periodStatus === 'closed'} value={r.gross_salary || 0} onChange={(e) => updateLineField(r.employee_id, 'gross_salary', e.target.value)} /></td>
                    <td className="num"><input type="number" disabled={periodStatus === 'closed'} value={r.bonuses || 0} onChange={(e) => updateLineField(r.employee_id, 'bonuses', e.target.value)} /></td>
                    <td><input type="checkbox" disabled={periodStatus === 'closed'} checked={r.nssf_enabled !== false} onMouseDown={stopDragBubbling} onClick={stopDragBubbling} onChange={(e) => updateLineField(r.employee_id, 'nssf_enabled', e.target.checked, false)} /></td>
                    <td className="num">{Number(r.nssf_amount || 0).toLocaleString()}</td>
                    <td className="num">{Number(r.employer_nssf_amount || 0).toLocaleString()}</td>
                    <td className="num">{Number(r.taxable_income || 0).toLocaleString()}</td>
                    <td><input type="checkbox" disabled={periodStatus === 'closed'} checked={r.paye_enabled !== false} onMouseDown={stopDragBubbling} onClick={stopDragBubbling} onChange={(e) => updateLineField(r.employee_id, 'paye_enabled', e.target.checked, false)} /></td>
                    <td className="num">{Number(r.paye_estimate || 0).toLocaleString()}</td>
                    <td className="num">{Number(r.salary_advances || 0).toLocaleString()}</td>
                    <td className="num"><input type="number" disabled={periodStatus === 'closed'} value={r.other_deductions || 0} onChange={(e) => updateLineField(r.employee_id, 'other_deductions', e.target.value)} /></td>
                    <td className="num"><strong>{Number(r.net_salary || 0).toLocaleString()}</strong></td>
                    <td className="num"><strong>{Number(r.total_employer_cost || 0).toLocaleString()}</strong></td>
                  </tr>
                ))}
                {payroll.length === 0 && <tr><td colSpan={13}>{loading ? 'Loading payroll rows...' : 'No payroll rows'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canManagePayroll && activeStep === 'statements' && (
        <div className="payroll-card">
          <div className="payroll-card-head">
            <h3>Saved salary statements</h3>
            <p className="payroll-card-subtitle">
              Viewing <strong>{formatPayrollMonthLabel(monthKey)}</strong> — totals match the cards above when saved.
            </p>
          </div>

          <div className="payroll-statements-grid" role="list" aria-label="Saved payroll months">
            {payrollHistory.map((h) => {
              const selected = monthKey === h.month_key;
              const gross = Number(h.total_gross_compensation ?? 0);
              const totalNet = Number(h.total_net_salary || 0);
              const empCount = Number(h.processed_employees || 0);
              return (
                <button
                  key={h.month_key}
                  type="button"
                  role="listitem"
                  className={`payroll-statement-card ${selected ? 'is-selected' : ''}`}
                  onClick={() => setMonthKey(h.month_key)}
                >
                  <div className="payroll-statement-card-top">
                    <span className="payroll-statement-month">{formatPayrollMonthLabel(h.month_key)}</span>
                    <span className={`payroll-badge ${String(h.payroll_status).toLowerCase()}`}>{h.payroll_status}</span>
                  </div>
                  <div className="payroll-statement-stats">
                    <div>
                      <span className="stat-label">Employees</span>
                      <span className="stat-value">{empCount}</span>
                    </div>
                    <div>
                      <span className="stat-label">Gross</span>
                      <span className="stat-value">{moneyTzs(gross)}</span>
                    </div>
                    <div>
                      <span className="stat-label">Net</span>
                      <span className="stat-value">{moneyTzs(totalNet)}</span>
                    </div>
                  </div>
                  {h.completed_on && (
                    <span className="payroll-statement-meta">Completed {h.completed_on}</span>
                  )}
                  {String(h.payroll_status) === 'Open' && outstandingNetForHistoryRow(h) > 0 && (
                    <span className="payroll-statement-meta payroll-statement-meta--warn">
                      Outstanding net: {moneyTzs(outstandingNetForHistoryRow(h))}
                    </span>
                  )}
                </button>
              );
            })}
            {payrollHistory.length === 0 && (
              <p className="payroll-history-empty">
                No saved payroll yet. Enter figures under Monthly pay run and click Save payroll.
              </p>
            )}
          </div>

          <div className="payroll-export-section">
            <h4>Export for {formatPayrollMonthLabel(monthKey)}</h4>
            <div className="payroll-action-bar">
              <button type="button" className="payroll-action-btn statement" onClick={handleSalaryStatement}>Salary statement</button>
              <button type="button" className="payroll-action-btn transfer" onClick={handleBankTransfer}>Bank transfer CSV</button>
              <button type="button" className="payroll-action-btn slips" onClick={handlePayslips}>Payslips</button>
              <button type="button" className="payroll-action-btn transfer" onClick={handlePayrollSpreadsheet}>Excel spreadsheet</button>
            </div>
            <div className="employee-statement-controls">
              <select value={selectedEmployeeStatement} onChange={(e) => setSelectedEmployeeStatement(e.target.value)}>
                <option value="">Select employee for individual statement…</option>
                {employeeOptions.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
              <button type="button" className="payroll-action-btn statement" onClick={handleEmployeeStatement}>Export employee statement</button>
            </div>
          </div>
        </div>
      )}

      {canRecordAdvances && (
        <div className="payroll-card">
          <h3>Salary Advances ({monthKey})</h3>
          <div
            className="payroll-table-wrap advances-wrap interactive-scroll-region"
            tabIndex={0}
            role="region"
            aria-label="Salary advances table"
            {...tableScrollHandlers}
          >
            <table className="payroll-table payroll-table--advances">
              <thead><tr><th>Date</th><th>Employee</th><th className="num">Amount</th><th>Notes</th></tr></thead>
              <tbody>
                {advances.map((a) => (
                  <tr key={a.id}>
                    <td>{a.advance_date}</td>
                    <td>{a.full_name}</td>
                    <td className="num">{Number(a.amount || 0).toLocaleString()}</td>
                    <td>{a.notes || '-'}</td>
                  </tr>
                ))}
                {advances.length === 0 && <tr><td colSpan={4}>{loading ? 'Loading salary advances...' : 'No advances recorded'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default Payroll;
