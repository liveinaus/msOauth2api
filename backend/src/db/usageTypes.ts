/**
 * Configuration for an integration type.
 *
 * A type works without a row here -- the pool API accepts any label -- so this is an
 * overlay that teaches the server how to recognise one service's mail: which sender and
 * subject count, and how to pull the code out when the generic extractor is not enough.
 */
import { db } from "./database";
import { normaliseType } from "./usages";

export type UsageType = {
  id: number;
  /** Normalised key, matching the `type` recorded against an address. */
  name: string;
  /** Display name, free-form. Falls back to the name. */
  label: string | null;
  fromFilter: string | null;
  subjectFilter: string | null;
  /** Regular expression; capture group 1 when present, otherwise the whole match. */
  codePattern: string | null;
  createdAt: number;
  updatedAt: number;
};

type UsageTypeRow = {
  id: number;
  name: string;
  label: string | null;
  from_filter: string | null;
  subject_filter: string | null;
  code_pattern: string | null;
  created_at: number;
  updated_at: number;
};

export type UsageTypeInput = {
  name: string;
  label?: string | null;
  fromFilter?: string | null;
  subjectFilter?: string | null;
  codePattern?: string | null;
};

function toType(row: UsageTypeRow): UsageType {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    fromFilter: row.from_filter,
    subjectFilter: row.subject_filter,
    codePattern: row.code_pattern,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listUsageTypes(): UsageType[] {
  const rows = db.prepare("SELECT * FROM usage_types ORDER BY name ASC").all() as UsageTypeRow[];
  return rows.map(toType);
}

export function getUsageType(id: number): UsageType | undefined {
  const row = db.prepare("SELECT * FROM usage_types WHERE id = ?").get(id) as
    UsageTypeRow | undefined;
  return row ? toType(row) : undefined;
}

export function getUsageTypeByName(name: string): UsageType | undefined {
  const row = db.prepare("SELECT * FROM usage_types WHERE name = ?").get(normaliseType(name)) as
    UsageTypeRow | undefined;
  return row ? toType(row) : undefined;
}

/** A stored pattern is compiled here, so one bad expression cannot take a request down. */
export function compilePattern(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    // Case-insensitive and ungreedy of flags on purpose: the stored value is a bare pattern,
    // and a global flag would carry lastIndex between uses.
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function isValidPattern(pattern: string): boolean {
  return compilePattern(pattern) !== null;
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function createUsageType(input: UsageTypeInput): UsageType {
  const now = Date.now();
  const name = normaliseType(input.name);
  const result = db
    .prepare(
      `INSERT INTO usage_types (name, label, from_filter, subject_filter, code_pattern, created_at, updated_at)
       VALUES (@name, @label, @fromFilter, @subjectFilter, @codePattern, @now, @now)`,
    )
    .run({
      name,
      label: trimOrNull(input.label),
      fromFilter: trimOrNull(input.fromFilter),
      subjectFilter: trimOrNull(input.subjectFilter),
      codePattern: trimOrNull(input.codePattern),
      now,
    });
  // Non-null: the insert above either succeeded or threw.
  return getUsageType(Number(result.lastInsertRowid))!;
}

/**
 * Applies the supplied fields. A field given as an empty string clears itself, which is how
 * the form removes a filter; a field left out entirely is untouched.
 */
export function updateUsageType(id: number, patch: Partial<UsageTypeInput>): UsageType | undefined {
  const existing = getUsageType(id);
  if (!existing) return undefined;

  const next = (key: keyof UsageTypeInput, current: string | null): string | null =>
    patch[key] === undefined ? current : trimOrNull(patch[key] as string | null);

  db.prepare(
    `UPDATE usage_types SET
       name           = @name,
       label          = @label,
       from_filter    = @fromFilter,
       subject_filter = @subjectFilter,
       code_pattern   = @codePattern,
       updated_at     = @now
     WHERE id = @id`,
  ).run({
    id,
    name: patch.name ? normaliseType(patch.name) : existing.name,
    label: next("label", existing.label),
    fromFilter: next("fromFilter", existing.fromFilter),
    subjectFilter: next("subjectFilter", existing.subjectFilter),
    codePattern: next("codePattern", existing.codePattern),
    now: Date.now(),
  });

  return getUsageType(id);
}

/** Only the configuration goes. Addresses keep their recorded use of the type. */
export function deleteUsageType(id: number): boolean {
  return db.prepare("DELETE FROM usage_types WHERE id = ?").run(id).changes > 0;
}
