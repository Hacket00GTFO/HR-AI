import nodemailer, { type Transporter } from 'nodemailer';
import type { ServiceConfig } from './config.js';

export function createTransport(config: ServiceConfig): Transporter {
    return nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } : undefined
    });
}

export interface Mail {
    to: string;
    subject: string;
    text: string;
    html?: string;
}

export async function sendMail(transporter: Transporter, from: string, mail: Mail): Promise<void> {
    await transporter.sendMail({ from, ...mail });
}
