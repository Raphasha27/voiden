import { createTransport } from 'nodemailer'
import type { RunResult, CliReportEntry } from '../types.js'

export interface MailReportOptions {
  to: string
  from?: string
  subject?: string
  smtpHost: string
  smtpPort?: number
  smtpSecure?: boolean
  smtpUser?: string
  smtpPass?: string
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function headersTable(headers?: Record<string, string>): string {
  if (!headers || !Object.keys(headers).length) return '<em style="color:#64748b">none</em>'
  const rows = Object.entries(headers)
    .map(([k, v]) => `<tr><td style="color:#94a3b8;padding:2px 8px 2px 0;white-space:nowrap">${esc(k)}</td><td style="padding:2px 0;word-break:break-all">${esc(v)}</td></tr>`)
    .join('')
  return `<table style="border-collapse:collapse;font-size:12px">${rows}</table>`
}

function codeBlock(text?: string): string {
  if (!text) return '<em style="color:#64748b">none</em>'
  return `<pre style="background:#0f172a;color:#94a3b8;padding:10px;border-radius:4px;font-size:12px;overflow:auto;max-height:250px;margin:0;white-space:pre-wrap;word-break:break-all">${esc(text)}</pre>`
}

function assertionRows(entries?: CliReportEntry[]): string {
  const assertions = (entries ?? []).filter(e => e.type === 'assertion')
  if (!assertions.length) return ''
  const rows = assertions.map(e => {
    if (e.type !== 'assertion') return ''
    const icon = e.passed ? '✓' : '✗'
    const color = e.passed ? '#4ade80' : '#f87171'
    let detail = ''
    if (!e.passed && e.actual !== undefined && e.expected !== undefined) {
      detail = ` <span style="color:#64748b;font-size:11px">(got ${esc(JSON.stringify(e.actual))}, expected ${esc(String(e.operator ?? '=='))} ${esc(JSON.stringify(e.expected))})</span>`
    }
    return `<div style="color:${color};margin:2px 0;font-size:13px">${icon} ${esc(e.message)}${detail}</div>`
  }).join('')
  const passed = assertions.filter(e => e.type === 'assertion' && e.passed).length
  const failed = assertions.length - passed
  return `
    <tr>
      <td style="${TD_LABEL}">Assertions</td>
      <td style="${TD_VALUE}">
        <span style="color:#4ade80">${passed} passed</span>
        ${failed > 0 ? `<span style="color:#f87171;margin-left:8px">${failed} failed</span>` : ''}
        <div style="margin-top:6px">${rows}</div>
      </td>
    </tr>`
}

const TD_LABEL = 'padding:8px 16px 8px 0;color:#64748b;vertical-align:top;white-space:nowrap;font-size:13px;width:140px'
const TD_VALUE = 'padding:8px 0;vertical-align:top;font-size:13px;color:#e2e8f0;word-break:break-word'

function requestCard(file: string, result: RunResult, index: number, total: number): string {
  const success = result.success
  const statusColor = success ? '#4ade80' : '#f87171'
  const borderColor = success ? '#166534' : '#7f1d1d'

  const statusBadge = result.status !== undefined
    ? `<span style="color:${statusColor};font-weight:600">${result.status} ${result.statusText ?? ''}</span>`
    : result.connected !== undefined
      ? `<span style="color:${statusColor}">${result.connected ? 'Connected' : 'Failed to connect'}</span>`
      : ''

  return `
    <div style="background:#1e293b;border:1px solid ${borderColor};border-radius:8px;margin-bottom:20px;overflow:hidden">
      <div style="background:#0f172a;padding:12px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid ${borderColor}">
        <span style="color:${statusColor};font-size:16px;font-weight:700">${success ? '✓' : '✗'}</span>
        <span style="color:#94a3b8;font-size:12px">[${index}/${total}]</span>
        <span style="color:#e2e8f0;font-weight:600;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(file)}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;padding:8px 16px">
        <tr>
          <td style="${TD_LABEL}">Protocol</td>
          <td style="${TD_VALUE}">
            <code style="color:#7dd3fc;background:#0f172a;padding:2px 6px;border-radius:3px">${esc(result.protocol.toUpperCase())} ${esc(result.method ?? '')}</code>
          </td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">URL</td>
          <td style="${TD_VALUE}"><code style="color:#7dd3fc">${esc(result.url)}</code></td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">Status</td>
          <td style="${TD_VALUE}">${statusBadge}</td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">Duration</td>
          <td style="${TD_VALUE}">${result.durationMs}ms${result.size !== undefined ? ` · ${result.size}B` : ''}</td>
        </tr>
        ${result.error ? `<tr><td style="${TD_LABEL}">Error</td><td style="${TD_VALUE};color:#f87171">${esc(result.error)}</td></tr>` : ''}
        ${assertionRows(result.reportEntries)}
        <tr>
          <td style="${TD_LABEL}">Request Headers</td>
          <td style="${TD_VALUE}">${headersTable(result.requestHeaders)}</td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">Request Body</td>
          <td style="${TD_VALUE}">${codeBlock(result.requestBody)}</td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">Response Headers</td>
          <td style="${TD_VALUE}">${headersTable(result.responseHeaders)}</td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">Response Body</td>
          <td style="${TD_VALUE}">${codeBlock(result.body)}</td>
        </tr>
      </table>
    </div>`
}

function buildHtml(
  results: Array<{ file: string; result: RunResult }>,
  totalMs: number,
): string {
  const passed = results.filter(r => r.result.success).length
  const failed = results.length - passed
  const cards = results.map(({ file, result }, i) => requestCard(file, result, i + 1, results.length)).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>voiden-runner report</title>
</head>
<body style="margin:0;padding:24px;background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:900px;margin:0 auto">
    <h1 style="color:#7dd3fc;font-size:22px;margin:0 0 4px">voiden-runner report</h1>
    <p style="color:#64748b;font-size:13px;margin:0 0 20px">${new Date().toUTCString()} · ${totalMs}ms total</p>
    <div style="background:#1e293b;border-radius:8px;padding:16px 20px;margin-bottom:24px;display:flex;gap:24px">
      <div><span style="font-size:28px;font-weight:700;color:#4ade80">${passed}</span><br><span style="color:#64748b;font-size:12px">PASSED</span></div>
      <div><span style="font-size:28px;font-weight:700;color:${failed > 0 ? '#f87171' : '#64748b'}">${failed}</span><br><span style="color:#64748b;font-size:12px">FAILED</span></div>
      <div><span style="font-size:28px;font-weight:700;color:#94a3b8">${results.length}</span><br><span style="color:#64748b;font-size:12px">TOTAL</span></div>
    </div>
    ${cards}
  </div>
</body>
</html>`
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendMailReport(
  results: Array<{ file: string; result: RunResult }>,
  totalMs: number,
  opts: MailReportOptions,
): Promise<void> {
  const passed = results.filter(r => r.result.success).length
  const failed = results.length - passed

  const transport = createTransport({
    host:   opts.smtpHost,
    port:   opts.smtpPort ?? (opts.smtpSecure ? 465 : 587),
    secure: opts.smtpSecure ?? false,
    auth:   opts.smtpUser ? { user: opts.smtpUser, pass: opts.smtpPass ?? '' } : undefined,
  })

  const subject = opts.subject
    ?? `voiden-runner: ${passed}/${results.length} passed${failed > 0 ? ` · ${failed} failed` : ' · all passed'}`

  await transport.sendMail({
    from: opts.from ?? opts.smtpUser ?? 'voiden-runner',
    to:   opts.to,
    subject,
    html: buildHtml(results, totalMs),
  })
}
