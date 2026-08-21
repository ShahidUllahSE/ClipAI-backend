import nodemailer from 'nodemailer'
import { env } from '../config'

function smtpPassword() {
  // Gmail app passwords are often pasted with spaces
  return env.DEFAULT_SMTP_PASSWORD.replace(/\s+/g, '')
}

function isConfigured() {
  return Boolean(env.DEFAULT_SMTP_EMAIL && smtpPassword())
}

function createTransport() {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.DEFAULT_SMTP_EMAIL,
      pass: smtpPassword(),
    },
  })
}

async function sendMail(input: {
  to: string
  subject: string
  text: string
  html: string
}) {
  if (!isConfigured()) {
    throw new Error(
      'SMTP is not configured. Set DEFAULT_SMTP_EMAIL and DEFAULT_SMTP_PASSWORD.',
    )
  }

  const transport = createTransport()
  await transport.sendMail({
    from: `"ClipAI" <${env.DEFAULT_SMTP_EMAIL}>`,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  })
}

function layout(title: string, bodyHtml: string, actionUrl: string, cta: string) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e4e4e7;">
          <tr><td style="font-size:22px;font-weight:700;color:#18181b;padding-bottom:12px;">${title}</td></tr>
          <tr><td style="font-size:15px;line-height:1.6;color:#3f3f46;padding-bottom:24px;">${bodyHtml}</td></tr>
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <a href="${actionUrl}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;">${cta}</a>
            </td>
          </tr>
          <tr><td style="font-size:12px;color:#71717a;word-break:break-all;">Or open: ${actionUrl}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export const mailService = {
  isConfigured,

  async sendVerifyEmail(to: string, verifyUrl: string) {
    await sendMail({
      to,
      subject: 'Verify your ClipAI email',
      text: `Welcome to ClipAI.\n\nVerify your email:\n${verifyUrl}\n\nThis link expires soon.`,
      html: layout(
        'Verify your email',
        'Thanks for joining <strong>ClipAI</strong>. Confirm your email to finish setting up your account.',
        verifyUrl,
        'Verify email',
      ),
    })
  },

  async sendPasswordReset(to: string, resetUrl: string) {
    await sendMail({
      to,
      subject: 'Reset your ClipAI password',
      text: `Reset your ClipAI password:\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
      html: layout(
        'Reset your password',
        'We received a request to reset your ClipAI password. Click below to choose a new one. If you did not ask for this, you can ignore this email.',
        resetUrl,
        'Reset password',
      ),
    })
  },
}
