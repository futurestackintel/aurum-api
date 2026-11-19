import { LedgerService } from './ledger.js';
import { validateCurrencyCode } from './money.js';

function requireId(value, fieldName) {
if (typeof value !== 'string' || value.trim() === '') {
throw new Error("${fieldName} is required");
}

return value.trim();
}

function accountDefinitions(ownerType, ownerId, currencyCode) {
const definitions = {
user: [
{
accountCode: "USER:AVAILABLE:${ownerId}:${currencyCode}",
accountName: 'User Available Wallet',
accountClass: 'liability',
normalBalance: 'credit',
ownerType: 'user',
ownerId,
currencyCode,
},
{
accountCode: "USER:HELD:${ownerId}:${currencyCode}",
accountName: 'User Held Wallet',
accountClass: 'liability',
normalBalance: 'credit',
ownerType: 'user',
ownerId,
currencyCode,
},
],

crew: [
  {
    accountCode: `CREW:AVAILABLE:${ownerId}:${currencyCode}`,
    accountName: 'Crew Available Wallet',
    accountClass: 'liability',
    normalBalance: 'credit',
    ownerType: 'crew',
    ownerId,
    currencyCode,
  },
  {
    accountCode: `CREW:HELD:${ownerId}:${currencyCode}`,
    accountName: 'Crew Held Wallet',
    accountClass: 'liability',
    normalBalance: 'credit',
    ownerType: 'crew',
    ownerId,
    currencyCode,
  },
],

};

return definitions[ownerType];
}

export class AccountProvisioningService {
constructor(db) {
if (!db) {
throw new Error('A D1 database binding is required');
}

this.db = db;
this.ledger = new LedgerService(db);

}

async getOrCreateAccount(definition) {
const {
accountCode,
accountName,
accountClass,
normalBalance,
ownerType,
ownerId = null,
currencyCode,
} = definition;

const existing = await this.db
  .prepare(`
    SELECT *
    FROM ledger_accounts
    WHERE account_code = ?
  `)
  .bind(accountCode)
  .first();

if (existing) {
  this.assertAccountIdentity(existing, definition);
  return existing;
}

try {
  return await this.ledger.createAccount({
    accountCode,
    accountName,
    accountClass,
    normalBalance,
    ownerType,
    ownerId,
    currencyCode,
  });
} catch (error) {
  // Another request may have created the same account concurrently.
  const racedAccount = await this.db
    .prepare(`
      SELECT *
      FROM ledger_accounts
      WHERE account_code = ?
    `)
    .bind(accountCode)
    .first();

  if (!racedAccount) {
    throw error;
  }

  this.assertAccountIdentity(racedAccount, definition);
  return racedAccount;
}

}

assertAccountIdentity(account, definition) {
const matches =
account.account_code === definition.accountCode &&
account.account_class === definition.accountClass &&
account.normal_balance === definition.normalBalance &&
account.owner_type === definition.ownerType &&
account.owner_id === (definition.ownerId ?? null) &&
account.currency_code === definition.currencyCode;

if (!matches) {
  throw new Error(
    `Existing ledger account identity conflicts with requested account: ${definition.accountCode}`
  );
}

}

async provisionUserAccounts(userId, currencyCode) {
userId = requireId(userId, 'User ID');
currencyCode = validateCurrencyCode(currencyCode);

const definitions = accountDefinitions(
  'user',
  userId,
  currencyCode
);

const accounts = [];

for (const definition of definitions) {
  accounts.push(
    await this.getOrCreateAccount(definition)
  );
}

return {
  ownerType: 'user',
  ownerId: userId,
  currencyCode,
  accounts,
};

}

async provisionCrewAccounts(crewId, currencyCode) {
crewId = requireId(crewId, 'Crew ID');
currencyCode = validateCurrencyCode(currencyCode);

const definitions = accountDefinitions(
  'crew',
  crewId,
  currencyCode
);

const accounts = [];

for (const definition of definitions) {
  accounts.push(
    await this.getOrCreateAccount(definition)
  );
}

return {
  ownerType: 'crew',
  ownerId: crewId,
  currencyCode,
  accounts,
};

}

async provisionEscrowAccount({
escrowType,
escrowId,
currencyCode,
}) {
const supportedTypes = [
'DUEL',
'CHALLENGE',
'CREW_BATTLE',
];

if (!supportedTypes.includes(escrowType)) {
  throw new Error('Unsupported escrow type');
}

escrowId = requireId(escrowId, 'Escrow ID');
currencyCode = validateCurrencyCode(currencyCode);

const definition = {
  accountCode: `${escrowType}:ESCROW:${escrowId}:${currencyCode}`,
  accountName: `${escrowType.replace('_', ' ')} Escrow`,
  accountClass: 'liability',
  normalBalance: 'credit',
  ownerType: 'escrow',
  ownerId: `${escrowType.toLowerCase()}:${escrowId}`,
  currencyCode,
};

return this.getOrCreateAccount(definition);

}

async provisionProviderClearingAccount({
provider,
currencyCode,
}) {
provider = requireId(provider, 'Provider');
currencyCode = validateCurrencyCode(currencyCode);

const definition = {
  accountCode: `PROVIDER:CLEARING:${provider}:${currencyCode}`,
  accountName: `${provider} Clearing`,
  accountClass: 'asset',
  normalBalance: 'debit',
  ownerType: 'provider',
  ownerId: provider,
  currencyCode,
};

return this.getOrCreateAccount(definition);

}

async provisionPlatformAccount({
accountType,
currencyCode,
}) {
const definitions = {
operating: {
accountCode: "PLATFORM:OPERATING:${currencyCode}",
accountName: 'Platform Operating Funds',
accountClass: 'asset',
normalBalance: 'debit',
},
fee_revenue: {
accountCode: "PLATFORM:FEE_REVENUE:${currencyCode}",
accountName: 'Platform Fee Revenue',
accountClass: 'revenue',
normalBalance: 'credit',
},
expenses: {
accountCode: "PLATFORM:EXPENSES:${currencyCode}",
accountName: 'Platform Expenses',
accountClass: 'expense',
normalBalance: 'debit',
},
equity: {
accountCode: "PLATFORM:EQUITY:${currencyCode}",
accountName: 'Platform Equity',
accountClass: 'equity',
normalBalance: 'credit',
},
};

if (!Object.prototype.hasOwnProperty.call(definitions, accountType)) {
  throw new Error('Unsupported platform account type');
}

currencyCode = validateCurrencyCode(currencyCode);

return this.getOrCreateAccount({
  ...definitions[accountType],
  ownerType: 'platform',
  ownerId: null,
  currencyCode,
});

}
}
