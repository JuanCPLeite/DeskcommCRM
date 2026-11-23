import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sync: vi.fn(),
  creds: vi.fn(),
}));
vi.mock("@/lib/channels/meta/template-sync", () => ({ syncTemplates: h.sync }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: h.creds }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  JANELA_DA_TRAVA_MS,
  ressincronizarModelosDaWaba,
  ressincronizarTodasAsWabas,
} from "@/lib/channels/meta/ressincronizar-modelos";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";

/** Banco falso mínimo: `meta_templates` devolve a última sincronização; `channel_sessions` o canal. */
function bancoFalso(opts: { syncedAt?: string | null; canal?: string | null; canais?: unknown[] }) {
  const q = (resposta: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "is", "not"]) c[m] = () => c;
    c.maybeSingle = async () => ({ data: resposta });
    c.then = (ok: (v: unknown) => unknown) => ok({ data: opts.canais ?? [] });
    return c;
  };
  return {
    from: (tabela: string) =>
      tabela === "meta_templates"
        ? q(opts.syncedAt ? { synced_at: opts.syncedAt } : null)
        : q(opts.canal ? { meta_phone_number_id: opts.canal } : null),
  } as never;
}

const ALVO = { organizationId: "org-1", wabaId: "waba-1" };
const AGORA = new Date("2026-11-23T13:00:00.000Z");

beforeEach(() => {
  h.sync.mockReset().mockResolvedValue({});
  h.creds.mockReset().mockResolvedValue({ token: "t", graphVersion: "v22.0" });
});

describe("ressincronizar os modelos da conta", () => {
  it("sincroniza com a credencial do canal da conta", async () => {
    const r = await ressincronizarModelosDaWaba(bancoFalso({ canal: "num-1" }), ALVO, {
      agora: AGORA,
    });
    expect(r).toBe("sincronizado");
    expect(h.sync).toHaveBeenCalledWith({
      organizationId: "org-1",
      wabaId: "waba-1",
      token: "t",
      graphVersion: "v22.0",
    });
  });

  it("rajada de eventos: sincronizado há poucos segundos não pergunta de novo", async () => {
    const recente = new Date(AGORA.getTime() - (JANELA_DA_TRAVA_MS - 1000)).toISOString();
    const r = await ressincronizarModelosDaWaba(
      bancoFalso({ syncedAt: recente, canal: "num-1" }),
      ALVO,
      { agora: AGORA },
    );
    expect(r).toBe("recente");
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("espelho velho passa pela trava; o cron ignora a trava", async () => {
    const velho = new Date(AGORA.getTime() - JANELA_DA_TRAVA_MS - 1000).toISOString();
    expect(
      await ressincronizarModelosDaWaba(bancoFalso({ syncedAt: velho, canal: "n" }), ALVO, {
        agora: AGORA,
      }),
    ).toBe("sincronizado");
    const fresco = new Date(AGORA.getTime() - 1000).toISOString();
    expect(
      await ressincronizarModelosDaWaba(bancoFalso({ syncedAt: fresco, canal: "n" }), ALVO, {
        agora: AGORA,
        ignorarTrava: true,
      }),
    ).toBe("sincronizado");
  });

  it("conta sem canal ativo ou sem credencial legível não chama a Meta", async () => {
    expect(
      await ressincronizarModelosDaWaba(bancoFalso({ canal: null }), ALVO, { agora: AGORA }),
    ).toBe("sem_canal");
    h.creds.mockResolvedValue(null);
    expect(
      await ressincronizarModelosDaWaba(bancoFalso({ canal: "n" }), ALVO, { agora: AGORA }),
    ).toBe("sem_credencial");
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("NUNCA lança: a Meta falhando vira desfecho, não 5xx no webhook", async () => {
    h.sync.mockRejectedValue(new Error("Graph API respondeu 500"));
    await expect(
      ressincronizarModelosDaWaba(bancoFalso({ canal: "n" }), ALVO, { agora: AGORA }),
    ).resolves.toBe("falhou");
  });

  it("o cron varre uma vez por conta, mesmo com vários números na mesma conta", async () => {
    const canais = [
      { organization_id: "org-1", meta_waba_id: "waba-1" },
      { organization_id: "org-1", meta_waba_id: "waba-1" },
      { organization_id: "org-2", meta_waba_id: "waba-9" },
    ];
    const r = await ressincronizarTodasAsWabas(bancoFalso({ canais, canal: "n" }));
    expect(r).toMatchObject({ contas: 2, sincronizadas: 2, falhas: 0 });
    expect(h.sync).toHaveBeenCalledTimes(2);
  });
});

describe("evento de conteúdo do modelo", () => {
  it("message_template_components_update vira template_content", () => {
    const eventos = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "message_template_components_update",
              value: { message_template_name: "meu_modelo", message_template_language: "pt_BR" },
            },
          ],
        },
      ],
    } as never);
    expect(eventos).toEqual([
      {
        kind: "template_content",
        wabaId: "waba-1",
        templateName: "meu_modelo",
        templateLanguage: "pt_BR",
      },
    ]);
  });
});

describe("o cron respeita a organização parada", () => {
  it("conta de organização suspensa não é sincronizada", async () => {
    const canais = [
      { organization_id: "org-parada", meta_waba_id: "waba-1" },
      { organization_id: "org-ativa", meta_waba_id: "waba-2" },
    ];
    const r = await ressincronizarTodasAsWabas(bancoFalso({ canais, canal: "n" }), new Set(["org-parada"]));
    expect(r.contas).toBe(1);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.sync.mock.calls[0]![0]).toMatchObject({ organizationId: "org-ativa" });
  });
});
