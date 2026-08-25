/**
 * Synthetic email fixtures for the IMAP/SMTP reference adapter.
 *
 * Every address, name, message id and domain here is synthetic (DEC-18).
 * Domains use the reserved .test and .example TLDs.
 */

/** Simple single-part plain-text message, CRLF line endings. */
export const SIMPLE_TEXT_EMAIL = [
  'From: Dana Doe <dana.doe@example.test>',
  'To: support@acme.example',
  'Subject: Order 4471 arrived damaged',
  'Date: Mon, 6 Jan 2025 10:04:00 +0000',
  'Message-ID: <order-4471-damaged@example.test>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'The box arrived with a crushed corner.',
  'Two tiles are broken. What can you do?',
].join('\r\n');

/** Multi-line Subject header exercises header unfolding. */
export const FOLDED_HEADERS_EMAIL = [
  'From: dana.doe@example.test',
  'To: support@acme.example',
  'Cc: billing@acme.example, dana.doe@example.test',
  'Subject: Invoice 8812 question about',
  ' the prorated charge',
  'Date: Tue, 7 Jan 2025 09:30:00 +0100',
  'Message-ID: <invoice-8812-q@example.test>',
  '',
  'Why is the prorated charge higher than last month?',
].join('\r\n');

/** Quoted-printable body plus RFC 2047 encoded words in Subject and From. */
export const QUOTED_PRINTABLE_EMAIL = [
  'From: =?utf-8?Q?Ren=C3=A9e?= Dupont <renee.dupont@example.test>',
  'To: support@acme.example',
  'Subject: =?utf-8?Q?Caf=C3=A9_order_missing?=',
  'Message-ID: <qp-cafe-missing@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'My espresso machine order #2231 has not=',
  ' arrived. The tracking page says delivered=',
  ' but nothing is here.',
].join('\r\n');

/** Base64-encoded body. Payload decodes to "Password reset link expired." */
export const BASE64_EMAIL = [
  'From: sam.smith@example.test',
  'To: support@acme.example',
  'Subject: Reset link dead',
  'Message-ID: <b64-reset-dead@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('Password reset link expired.', 'utf8').toString('base64'),
].join('\r\n');

/** multipart/alternative: the adapter must prefer text/plain over text/html. */
export const ALTERNATIVE_EMAIL = [
  'From: dana.doe@example.test',
  'To: support@acme.example',
  'Subject: Refund status',
  'Message-ID: <alt-refund-status@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="ALT-42"',
  '',
  '--ALT-42',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Where is my refund for order 9981?',
  '--ALT-42',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>Where is my refund for <b>order 9981</b>?</p></body></html>',
  '--ALT-42--',
].join('\r\n');

/** HTML-only message: tags and entities get stripped into readable text. */
export const HTML_ONLY_EMAIL = [
  'From: dana.doe@example.test',
  'To: support@acme.example',
  'Subject: Login loop',
  'Message-ID: <html-login-loop@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>The &quot;Sign in&quot; button sends me back</p>',
  '<p>to the login page. Account ID &lt;ACME-77&gt;.</p></body></html>',
].join('\r\n');

const MIXED_BOUNDARY = 'MIXED-7';

const ATTACHMENT_PART = [
  `--${MIXED_BOUNDARY}`,
  'Content-Type: application/pdf; name="receipt-5512.pdf"',
  'Content-Disposition: attachment; filename="receipt-5512.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('synthetic receipt bytes', 'utf8').toString('base64'),
];

/** multipart/mixed: inline plain body plus one PDF attachment. */
export const MIXED_ATTACHMENT_EMAIL = [
  'From: pri.patel@example.test',
  'To: support@acme.example',
  'Subject: Receipt for order 5512',
  'Message-ID: <mixed-receipt-5512@example.test>',
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${MIXED_BOUNDARY}"`,
  '',
  `--${MIXED_BOUNDARY}`,
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Attached is the receipt. I was charged twice.',
  ATTACHMENT_PART.join('\r\n'),
  `--${MIXED_BOUNDARY}--`,
].join('\r\n');

/**
 * Thread root plus reply. Both must normalize onto the same ticket,
 * keyed by the thread root Message-ID.
 */
export const THREAD_ROOT_EMAIL = [
  'From: dana.doe@example.test',
  'To: support@acme.example',
  'Subject: Order 4471 arrived damaged',
  'Date: Mon, 6 Jan 2025 10:04:00 +0000',
  'Message-ID: <thread-root@acme.example>',
  '',
  'The box arrived with a crushed corner.',
].join('\r\n');

export const THREAD_REPLY_EMAIL = [
  'From: support@acme.example',
  'To: dana.doe@example.test',
  'Subject: Re: Order 4471 arrived damaged',
  'Date: Mon, 6 Jan 2025 11:15:00 +0000',
  'Message-ID: <thread-reply-1@acme.example>',
  'In-Reply-To: <thread-root@acme.example>',
  'References: <thread-root@acme.example>',
  '',
  'We are sorry. A replacement ships today.',
].join('\r\n');

/** Second-level reply whose References chain starts at the same root. */
export const THREAD_DEEP_REPLY_EMAIL = [
  'From: dana.doe@example.test',
  'To: support@acme.example',
  'Subject: Re: Order 4471 arrived damaged',
  'Message-ID: <thread-reply-2@acme.example>',
  'In-Reply-To: <thread-reply-1@acme.example>',
  'References: <thread-root@acme.example> <thread-reply-1@acme.example>'
    + ' <thread-reply-2@acme.example>',
  '',
  'Thank you. Which carrier?',
].join('\r\n');

/** No Message-ID, In-Reply-To or References anywhere. */
export const NO_IDS_EMAIL = [
  'From: anon@example.test',
  'To: support@acme.example',
  'Subject: Question',
  '',
  'Do you ship to islands?',
].join('\r\n');
