import { Router } from "express";
import { createApiKey, deleteApiKey, listApiKeys } from "../auth/credentials";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/", (_req, res) => {
  res.json(listApiKeys());
});

router.post("/", async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const { record, key } = await createApiKey(name.trim());
  // The only time the plain key is ever returned. Only its hash is stored, so a lost key
  // is replaced rather than recovered.
  res.status(201).json({ ...record, key });
});

router.delete("/:id", (req, res) => {
  if (!deleteApiKey(Number(req.params.id))) {
    res.status(404).json({ error: "API key not found" });
    return;
  }
  res.status(204).end();
});

export default router;
