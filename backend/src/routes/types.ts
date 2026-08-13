/** Panel CRUD for integration type configuration. */
import { Router } from "express";
import {
  createUsageType,
  deleteUsageType,
  getUsageTypeByName,
  isValidPattern,
  listUsageTypes,
  updateUsageType,
} from "../db/usageTypes";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

const NAME_PATTERN = /^[a-z0-9][a-z0-9 ._-]{0,40}$/i;
const PATTERN_MAX = 200;

/**
 * Names become the key recorded against an address and travel in query strings, so they are
 * kept to plain characters rather than accepting anything the form will send.
 */
function nameError(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return "name is required";
  if (!NAME_PATTERN.test(name.trim())) return "name may use letters, digits, space, . _ - only";
  return null;
}

/** A pattern is rejected at the door: a broken one would silently match nothing later. */
function patternError(pattern: unknown): string | null {
  if (pattern === undefined || pattern === null || pattern === "") return null;
  if (typeof pattern !== "string") return "codePattern must be a string";
  if (pattern.length > PATTERN_MAX) return `codePattern must be under ${PATTERN_MAX} characters`;
  if (!isValidPattern(pattern)) return "codePattern is not a valid regular expression";
  return null;
}

router.get("/", (_req, res) => {
  res.json(listUsageTypes());
});

router.post("/", (req, res) => {
  const { name, label, fromFilter, subjectFilter, codePattern } = req.body ?? {};

  const problem = nameError(name) ?? patternError(codePattern);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  if (getUsageTypeByName(name)) {
    res.status(409).json({ error: `Type "${name}" already exists` });
    return;
  }

  res.status(201).json(createUsageType({ name, label, fromFilter, subjectFilter, codePattern }));
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, label, fromFilter, subjectFilter, codePattern } = req.body ?? {};

  const problem = (name === undefined ? null : nameError(name)) ?? patternError(codePattern);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const clash = name ? getUsageTypeByName(name) : undefined;
  if (clash && clash.id !== id) {
    res.status(409).json({ error: `Type "${name}" already exists` });
    return;
  }

  const updated = updateUsageType(id, { name, label, fromFilter, subjectFilter, codePattern });
  if (!updated) {
    res.status(404).json({ error: "Type not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", (req, res) => {
  if (!deleteUsageType(Number(req.params.id))) {
    res.status(404).json({ error: "Type not found" });
    return;
  }
  res.status(204).end();
});

export default router;
