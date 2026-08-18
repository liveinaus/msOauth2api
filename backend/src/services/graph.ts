import type { Mailbox, MailMessage } from "../types";
import { extractCode } from "./codes";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Graph names the junk folder differently from IMAP, so the wire name is mapped here. */
function graphFolder(mailbox: Mailbox): string {
  return mailbox === "Junk" ? "junkemail" : "inbox";
}

type GraphMessage = {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  body?: { content?: string | null };
  receivedDateTime?: string | null;
  createdDateTime?: string | null;
  from?: { emailAddress?: { address?: string | null } | null } | null;
};

function toMailMessage(item: GraphMessage): MailMessage {
  const text = item.bodyPreview ?? "";
  const html = item.body?.content ?? "";
  const message: MailMessage = {
    send: item.from?.emailAddress?.address ?? "",
    subject: item.subject ?? "",
    text,
    html,
    // Upstream reported createdDateTime here, so it stays the primary for compatibility.
    date: item.createdDateTime ?? item.receivedDateTime ?? "",
    id: item.id,
  };

  const code = extractCode(text, html, message.subject);
  if (code) message.code = code;
  return message;
}

async function graphRequest(path: string, accessToken: string, init?: RequestInit) {
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Graph API ${response.status}: ${detail}`);
  }
  return response;
}

/**
 * Fetches messages newest first. `$select` keeps the payload to the fields that are
 * actually returned; upstream asked for whole messages and then discarded most of each
 * one, which on a busy mailbox is a lot of body HTML over the wire for nothing.
 */
export async function listMessages(
  accessToken: string,
  mailbox: Mailbox,
  limit: number,
): Promise<MailMessage[]> {
  const query = new URLSearchParams({
    $top: String(limit),
    $orderby: "receivedDateTime desc",
    $select: "id,subject,bodyPreview,body,receivedDateTime,createdDateTime,from",
  });

  const response = await graphRequest(
    `/me/mailFolders/${graphFolder(mailbox)}/messages?${query}`,
    accessToken,
  );
  const payload = (await response.json()) as { value?: GraphMessage[] };
  return (payload.value ?? []).map(toMailMessage);
}

/** Deletes one message. Graph ids are mailbox-wide, so the folder does not come into it. */
export async function deleteMessage(accessToken: string, id: string): Promise<void> {
  await graphRequest(`/me/messages/${encodeURIComponent(id)}`, accessToken, { method: "DELETE" });
}

/**
 * Empties a folder. Graph has no bulk delete, so ids are paged out and removed one at a
 * time; the concurrency cap keeps a large mailbox from opening hundreds of sockets at once
 * and being throttled.
 */
export async function purgeFolder(
  accessToken: string,
  mailbox: Mailbox,
): Promise<{ deleted: number }> {
  const folder = graphFolder(mailbox);
  let deleted = 0;

  for (;;) {
    const query = new URLSearchParams({ $top: "100", $select: "id" });
    const response = await graphRequest(`/me/mailFolders/${folder}/messages?${query}`, accessToken);
    const payload = (await response.json()) as { value?: { id: string }[] };
    const ids = (payload.value ?? []).map((m) => m.id);
    if (ids.length === 0) break;

    const CONCURRENCY = 5;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((id) =>
          graphRequest(`/me/messages/${id}`, accessToken, { method: "DELETE" }).then(
            () => {
              deleted++;
            },
            // A message deleted by someone else mid-sweep must not abort the whole purge.
            (error: unknown) => {
              console.warn(`[graph] could not delete message ${id}:`, error);
            },
          ),
        ),
      );
    }
  }

  return { deleted };
}
