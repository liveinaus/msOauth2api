import nodemailer from "nodemailer";

const SMTP_HOST = "smtp.office365.com";
const SMTP_PORT = 587;

export type SendMailInput = {
  email: string;
  clientId: string;
  accessToken: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

/** Sends through Outlook SMTP with an XOAUTH2 access token. */
export async function sendMail(input: SendMailInput): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: {
      type: "OAuth2",
      user: input.email,
      clientId: input.clientId,
      accessToken: input.accessToken,
    },
    // Upstream pinned `ciphers: 'SSLv3'`, which asks OpenSSL for a cipher suite that
    // modern builds refuse outright. Leaving TLS at its defaults is both current and what
    // Office 365 actually negotiates on 587.
  });

  try {
    const info = await transporter.sendMail({
      from: input.email,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { messageId: info.messageId };
  } finally {
    transporter.close();
  }
}
