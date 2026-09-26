// Pickup/drop-off verification: a short human-enterable PIN plus an
// HMAC-signed QR payload, so a driver can either type the code or scan it,
// and the payload can't be forged without the signing secret.

interface QrPayload {
  orderId: string;
  stage: 'pickup' | 'dropoff';
  pin: string;
  issuedAt: number;
}

function randomPin(): string {
  // 6-digit numeric, easy to read/type over a car window
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function generateVerificationCode(
  orderId: string,
  stage: 'pickup' | 'dropoff',
  secret: string
): Promise<{ pin: string; qrPayload: string }> {
  const pin = randomPin();
  const payload: QrPayload = { orderId, stage, pin, issuedAt: Date.now() };
  const json = JSON.stringify(payload);
  const signature = await hmacSign(json, secret);
  return { pin, qrPayload: JSON.stringify({ payload: json, signature }) };
}

/**
 * Verifies either a scanned QR payload OR a manually entered PIN against
 * the stored code for that order/stage. Returns true only if the code
 * matches AND (for QR) the signature is valid.
 */
export async function verifyCode(params: {
  input: { type: 'pin'; value: string } | { type: 'qr'; value: string };
  expectedPin: string;
  orderId: string;
  stage: 'pickup' | 'dropoff';
  secret: string;
}): Promise<boolean> {
  const { input, expectedPin, orderId, stage, secret } = params;

  if (input.type === 'pin') {
    return input.value.trim() === expectedPin;
  }

  try {
    const { payload: json, signature } = JSON.parse(input.value) as { payload: string; signature: string };
    const expectedSignature = await hmacSign(json, secret);
    if (signature !== expectedSignature) return false;

    const payload = JSON.parse(json) as QrPayload;
    return payload.orderId === orderId && payload.stage === stage && payload.pin === expectedPin;
  } catch {
    return false;
  }
}
