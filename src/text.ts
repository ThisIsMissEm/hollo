import { type DocumentLoader, isActor, lookupObject } from "@fedify/fedify";
import { mention } from "@fedify/markdown-it-mention";
import { type ExtractTablesWithRelations, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import MarkdownIt from "markdown-it";
import { persistAccount } from "./federation/account";
import * as schema from "./schema";

export interface FormatResult {
  html: string;
  mentions: string[];
}

export async function formatText(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  text: string,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<FormatResult> {
  // List all mentions:
  const draft = new MarkdownIt({ linkify: true }).use(mention, {});
  const draftEnv: { mentions: string[] } = { mentions: [] };
  draft.render(text, draftEnv);

  // Collect already persisted accounts:
  const handles: Record<string, { id: string; href: string }> = {};
  const handleList =
    draftEnv.mentions.length > 0
      ? await db
          .select({
            handle: schema.accounts.handle,
            id: schema.accounts.id,
            url: schema.accounts.url,
            iri: schema.accounts.iri,
          })
          .from(schema.accounts)
          .where(inArray(schema.accounts.handle, draftEnv.mentions))
      : [];
  for (const { handle, id, url, iri } of handleList) {
    handles[handle] = { href: url ?? iri, id };
  }

  // Persist new accounts:
  for (const mention of draftEnv.mentions) {
    if (mention in handles) continue;
    const actor = await lookupObject(mention, options);
    if (!isActor(actor) || actor.id == null) continue;
    const account = await persistAccount(db, actor, options);
    if (account == null) continue;
    handles[account.handle] = {
      href: account.url ?? account.iri,
      id: account.id,
    };
  }

  // Render the final HTML:
  const md = new MarkdownIt({ linkify: true }).use(mention, {
    link(handle) {
      if (handle in handles) return handles[handle].href;
      return null;
    },
    linkAttributes(handle: string) {
      return {
        "data-account-id": handles[handle].id,
        "data-account-handle": handle,
        translate: "no",
        class: "h-card u-url mention",
      };
    },
  });
  const html = md.render(text);
  return {
    html: html,
    mentions: Object.values(handles).map((v) => v.id),
  };
}

// cSpell: ignore linkify
