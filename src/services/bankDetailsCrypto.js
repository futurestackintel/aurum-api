function toBase64(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);

  return Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );
}

async function getEncryptionKey(env) {
  if (!env.WALLET_BANK_DETAILS_ENCRYPTION_KEY) {
    throw new Error('Bank details encryption key is not configured');
  }

  const rawKey = fromBase64(
    env.WALLET_BANK_DETAILS_ENCRYPTION_KEY
  );

  if (rawKey.length !== 32) {
    throw new Error('Bank details encryption key must be 32 bytes');
  }

  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBankAccountNumber(
  accountNumber,
  env
) {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(accountNumber)
  );

  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
    last4: accountNumber.slice(-4),
  };
}

export async function decryptBankAccountNumber(
  ciphertext,
  iv,
  env
) {
  if (!ciphertext || !iv) {
    throw new Error('Encrypted bank account details are incomplete');
  }

  const key = await getEncryptionKey(env);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64(iv),
    },
    key,
    fromBase64(ciphertext)
  );

  return new TextDecoder().decode(decrypted);
}
