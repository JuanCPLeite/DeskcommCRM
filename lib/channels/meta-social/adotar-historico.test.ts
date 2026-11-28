import { describe, expect, it } from "vitest";

import { adotarHistoricoDaConta } from "@/lib/channels/meta-social/store";

type Linha = Record<string, unknown>;

/** Um banco falso COM ESTADO: o filtro de verdade (eq/neq/not) e o update de verdade, para o teste provar o efeito. */
function banco(tabelas: Record<string, Linha[]>) {
  function consulta(nome: string) {
    const filtros: ((l: Linha) => boolean)[] = [];
    let patch: Linha | null = null;
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Linha) => {
        patch = p;
        return q;
      },
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
      not: (c: string, _op: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
      limit: () => q,
      then: (ok: (r: unknown) => unknown) => {
        const alvo = tabelas[nome]!.filter((l) => filtros.every((f) => f(l)));
        if (patch) for (const l of alvo) Object.assign(l, patch);
        return Promise.resolve({ data: patch ? null : alvo.map((l) => ({ ...l })), error: null }).then(ok);
      },
    };
    return q;
  }
  return { from: (n: string) => consulta(n) } as never;
}

const ORG = "org-A";
const CONTA = "17841400000000001";

function cenario() {
  return {
    channel_sessions: [
      { id: "antigo", organization_id: ORG, provider: "meta_social", social_account_id: CONTA, archived_at: "2026-11-28T00:00:00Z" },
      { id: "novo", organization_id: ORG, provider: "meta_social", social_account_id: CONTA, archived_at: null },
      { id: "de-outra-org", organization_id: "org-B", provider: "meta_social", social_account_id: CONTA, archived_at: "2026-11-27T00:00:00Z" },
    ],
    conversations: [
      { id: "c1", organization_id: ORG, channel_session_id: "antigo", provider_conversation_id: "pessoa-1" },
      { id: "c2", organization_id: ORG, channel_session_id: "antigo", provider_conversation_id: "pessoa-2" },
      { id: "cx", organization_id: "org-B", channel_session_id: "de-outra-org", provider_conversation_id: "pessoa-9" },
    ],
    messages: [
      { id: "m1", organization_id: ORG, conversation_id: "c1", channel_session_id: "antigo" },
      { id: "m2", organization_id: ORG, conversation_id: "c2", channel_session_id: "antigo" },
      { id: "mx", organization_id: "org-B", conversation_id: "cx", channel_session_id: "de-outra-org" },
    ],
  } as Record<string, Linha[]>;
}

describe("adotarHistoricoDaConta", () => {
  it("move as conversas e as mensagens do canal arquivado para o novo", async () => {
    const t = cenario();
    const r = await adotarHistoricoDaConta(banco(t), { organizationId: ORG, sessaoNovaId: "novo", socialAccountId: CONTA });
    expect(r.conversas).toBe(2);
    expect(t.conversations!.filter((c) => c.organization_id === ORG).every((c) => c.channel_session_id === "novo")).toBe(true);
    expect(t.messages!.filter((m) => m.organization_id === ORG).every((m) => m.channel_session_id === "novo")).toBe(true);
  });

  it("nunca toca a conta da OUTRA organização, mesmo com o mesmo id de conta", async () => {
    const t = cenario();
    await adotarHistoricoDaConta(banco(t), { organizationId: ORG, sessaoNovaId: "novo", socialAccountId: CONTA });
    expect(t.conversations!.find((c) => c.id === "cx")!.channel_session_id).toBe("de-outra-org");
    expect(t.messages!.find((m) => m.id === "mx")!.channel_session_id).toBe("de-outra-org");
  });

  it("a pessoa que já tem conversa no canal novo fica onde está (não junta duas conversas vivas)", async () => {
    const t = cenario();
    t.conversations!.push({ id: "c-nova", organization_id: ORG, channel_session_id: "novo", provider_conversation_id: "pessoa-1" });
    const r = await adotarHistoricoDaConta(banco(t), { organizationId: ORG, sessaoNovaId: "novo", socialAccountId: CONTA });
    expect(r.conversas).toBe(1);
    expect(t.conversations!.find((c) => c.id === "c1")!.channel_session_id).toBe("antigo");
    expect(t.conversations!.find((c) => c.id === "c2")!.channel_session_id).toBe("novo");
  });

  it("conta sem canal arquivado: não faz nada", async () => {
    const t = cenario();
    const r = await adotarHistoricoDaConta(banco(t), { organizationId: ORG, sessaoNovaId: "novo", socialAccountId: "outra-conta" });
    expect(r.conversas).toBe(0);
  });
});
