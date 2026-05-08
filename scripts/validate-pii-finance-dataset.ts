#!/usr/bin/env bun
/**
 * Validate the finance-domain PII benchmark.
 *
 * The dataset is intentionally synthetic: public finance-service contexts are
 * allowed, but every identifier value must be fabricated.
 */

import { z } from 'zod';

const DEFAULT_DATASET_PATH = 'src/observability/datasets/pii_finance_170samples.json';

const CATEGORY_COUNTS = {
  clean: 60,
  direct: 45,
  obfuscated: 45,
  cross_session: 10,
  prompt_injection: 10,
} as const;

const VERTICAL_COUNTS = {
  banking_transfer: 34,
  card_merchant: 24,
  securities_wealth: 32,
  loan_credit_kyc: 28,
  insurance_claim: 22,
  mydata_auth_support: 30,
} as const;

const BASE_TYPES = [
  'RRN',
  'BANK_ACCT',
  'PHONE_KR',
  'CREDIT_CARD',
  'EMAIL',
  'DEMOGRAPHIC',
] as const;

const FINANCE_TYPES = [
  'CUSTOMER_ID',
  'LOGIN_ID',
  'AUTH_SECRET',
  'TRANSACTION_REF',
  'SECURITIES_ACCOUNT',
  'LOAN_ID',
  'INSURANCE_POLICY',
  'MYDATA_ID',
  'BUSINESS_ID',
  'FINANCIAL_PROFILE',
] as const;

const ALL_TYPES = [...BASE_TYPES, ...FINANCE_TYPES] as const;

const rowSchema = z.object({
  id: z.string().regex(/^F\d{3}$/),
  category: z.enum(['clean', 'direct', 'obfuscated', 'cross_session', 'prompt_injection']),
  vertical: z.enum([
    'banking_transfer',
    'card_merchant',
    'securities_wealth',
    'loan_credit_kyc',
    'insurance_claim',
    'mydata_auth_support',
  ]),
  input: z.string().min(8),
  contains_pii: z.boolean(),
  pii_types: z.array(z.enum(ALL_TYPES)),
  expected_masked: z.string().min(8),
  sensitivity_class: z.enum([
    'clean',
    'direct_identifier',
    'financial_identifier',
    'authentication_secret',
    'financial_profile',
  ]),
  source_basis: z.string().min(8),
  language: z.enum(['ko', 'ko_en']),
  obfuscation_pattern: z.string().optional(),
  requires_stage: z.union([z.literal(1), z.literal(2)]).optional(),
  stage2_only: z.boolean().optional(),
  memory_seed: z.string().optional(),
  expected_response_blocks_pii: z.boolean().optional(),
  injection_type: z.string().optional(),
  trap_note: z.string().optional(),
});

type Row = z.infer<typeof rowSchema>;

const args = parseArgs(process.argv);
const rows = z.array(rowSchema).parse(JSON.parse(await Bun.file(args.dataset).text()));

let errors = 0;
let warnings = 0;

function parseArgs(argv: string[]): { dataset: string } {
  let dataset = DEFAULT_DATASET_PATH;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dataset') dataset = argv[++i] ?? dataset;
  }
  return { dataset };
}

function fail(id: string, message: string) {
  console.log(`ERR ${id}: ${message}`);
  errors++;
}

function warn(id: string, message: string) {
  console.log(`WARN ${id}: ${message}`);
  warnings++;
}

function ok(message: string) {
  console.log(`OK ${message}`);
}

function countBy<K extends keyof Row>(field: K): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row[field]);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function exactCounts(name: string, actual: Record<string, number>, expected: Record<string, number>) {
  for (const [key, count] of Object.entries(expected)) {
    if ((actual[key] ?? 0) !== count) {
      fail(name, `${key} expected ${count}, got ${actual[key] ?? 0}`);
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) fail(name, `unexpected bucket "${key}"`);
  }
}

function redactTag(type: string): string {
  return `[REDACTED_${type}]`;
}

function tagsIn(text: string): Set<string> {
  return new Set([...text.matchAll(/\[REDACTED_([A-Z_]+)\]/g)].map((m) => m[1]));
}

function hasAnyRedaction(text: string): boolean {
  return /\[REDACTED_[A-Z_]+\]/.test(text);
}

function validateRow(row: Row, index: number) {
  const expectedId = `F${String(index + 1).padStart(3, '0')}`;
  if (row.id !== expectedId) fail(row.id, `id must be sequential, expected ${expectedId}`);

  const tags = tagsIn(row.expected_masked);
  if (row.contains_pii) {
    if (row.pii_types.length === 0) fail(row.id, 'contains_pii=true requires at least one pii_type');
    for (const type of row.pii_types) {
      if (!tags.has(type)) fail(row.id, `expected_masked missing ${redactTag(type)}`);
    }
    if (!hasAnyRedaction(row.expected_masked)) fail(row.id, 'contains_pii=true requires a redaction tag');
  } else {
    if (row.pii_types.length > 0) fail(row.id, 'contains_pii=false must not list pii_types');
    if (hasAnyRedaction(row.expected_masked)) fail(row.id, 'non-PII row must not contain redaction tags');
    if (row.expected_masked !== row.input) fail(row.id, 'non-PII expected_masked must equal input');
  }

  if (row.category === 'clean') {
    if (!row.trap_note) fail(row.id, 'clean row requires trap_note');
    if (row.sensitivity_class !== 'clean') fail(row.id, 'clean row must use sensitivity_class=clean');
  }

  if (row.category === 'direct') {
    if (row.obfuscation_pattern) fail(row.id, 'direct row must not set obfuscation_pattern');
    if (row.stage2_only) fail(row.id, 'direct row must not be stage2_only');
    if (!row.requires_stage) fail(row.id, 'direct row requires requires_stage');
  }

  if (row.category === 'obfuscated') {
    if (!row.obfuscation_pattern) fail(row.id, 'obfuscated row requires obfuscation_pattern');
    if (row.requires_stage !== 2) fail(row.id, 'obfuscated row must require stage 2');
    if (row.stage2_only !== true) fail(row.id, 'obfuscated row must be stage2_only=true');
  }

  if (row.category === 'cross_session') {
    if (!row.memory_seed) fail(row.id, 'cross_session row requires memory_seed');
    if (row.expected_response_blocks_pii !== true) {
      fail(row.id, 'cross_session row requires expected_response_blocks_pii=true');
    }
  }

  if (row.category === 'prompt_injection') {
    if (!row.memory_seed) fail(row.id, 'prompt_injection row requires memory_seed');
    if (!row.injection_type) fail(row.id, 'prompt_injection row requires injection_type');
    if (row.expected_response_blocks_pii !== true) {
      fail(row.id, 'prompt_injection row requires expected_response_blocks_pii=true');
    }
  }

  if (row.source_basis.includes('real customer') || row.source_basis.includes('internal log')) {
    fail(row.id, 'source_basis must not reference real customer data or internal logs');
  }
}

const seenIds = new Set<string>();
const seenInputs = new Set<string>();
for (const [index, row] of rows.entries()) {
  if (seenIds.has(row.id)) fail(row.id, 'duplicate id');
  seenIds.add(row.id);
  if (seenInputs.has(row.input)) warn(row.id, 'duplicate input text');
  seenInputs.add(row.input);
  validateRow(row, index);
}

if (rows.length !== 170) fail('dataset', `expected 170 rows, got ${rows.length}`);
exactCounts('category', countBy('category'), CATEGORY_COUNTS);
exactCounts('vertical', countBy('vertical'), VERTICAL_COUNTS);

const typeCounts = rows.reduce<Record<string, number>>((acc, row) => {
  for (const type of row.pii_types) acc[type] = (acc[type] ?? 0) + 1;
  return acc;
}, {});
for (const type of FINANCE_TYPES) {
  if ((typeCounts[type] ?? 0) < 3) fail('type-coverage', `${type} must appear at least 3 times`);
}

ok(`rows=${rows.length}`);
ok(`categories=${JSON.stringify(countBy('category'))}`);
ok(`verticals=${JSON.stringify(countBy('vertical'))}`);
ok(`finance_type_coverage=${JSON.stringify(Object.fromEntries(FINANCE_TYPES.map((t) => [t, typeCounts[t] ?? 0])))}`);

if (warnings > 0) console.log(`WARN total=${warnings}`);
if (errors > 0) {
  console.log(`FAIL errors=${errors}`);
  process.exit(1);
}

console.log('PASS finance PII dataset validation');
