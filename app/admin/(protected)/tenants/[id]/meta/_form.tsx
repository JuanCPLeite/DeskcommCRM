"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  definirAcessoDaEmpresaNaMeta,
  type UpdateMetaSignupResult,
} from "@/app/actions/settings/updateMetaSignup";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "@/lib/auth/recusa-de-escrita-de-admin";

/** Os três estados de cada liberação: herda a instalação, libera, bloqueia. */
type Estado = "herda" | "libera" | "bloqueia";

const paraEstado = (v: boolean | null): Estado => (v === null ? "herda" : v ? "libera" : "bloqueia");
const doEstado = (e: Estado): boolean | null => (e === "herda" ? null : e === "libera");

interface Props {
  readonly organizationId: string;
  readonly embeddedSignup: boolean | null;
  readonly coexistencia: boolean | null;
  readonly maxNumeros: number | null;
  readonly padraoDaInstalacao: boolean;
  /** O app (app_id + config_id) está cadastrado? Sem isso liberar não abre nada. */
  readonly appConfigurado: boolean;
  readonly bancoSemATabela: boolean;
  readonly leituraFalhou: boolean;
}

/**
 * No escopo do módulo, e não dentro do render: um componente criado a cada render é
 * um componente NOVO para o React, que desmonta e remonta o `<select>` (perde o foco
 * a cada tecla) — e o lint `react-hooks/static-components` reprova.
 */
function Seletor({
  id,
  valor,
  aoMudar,
  rotuloDoPadrao,
}: {
  id: string;
  valor: Estado;
  aoMudar: (e: Estado) => void;
  rotuloDoPadrao: string;
}) {
  const t = useT();
  return (
    <select
      id={id}
      data-testid={id}
      value={valor}
      onChange={(e) => aoMudar(e.target.value as Estado)}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
    >
      <option value="herda">{`${t("Herdar da instalação")} (${rotuloDoPadrao})`}</option>
      <option value="libera">{t("Liberado")}</option>
      <option value="bloqueia">{t("Bloqueado")}</option>
    </select>
  );
}

export function AcessoDaEmpresaForm(props: Props) {
  const t = useT();
  const router = useRouter();
  const [signup, setSignup] = useState<Estado>(paraEstado(props.embeddedSignup));
  const [coex, setCoex] = useState<Estado>(paraEstado(props.coexistencia));
  const [max, setMax] = useState(props.maxNumeros === null ? "" : String(props.maxNumeros));
  const [ocupado, iniciar] = useTransition();

  const maxNumerico = max.trim() === "" ? null : Number(max);
  const maxValido = maxNumerico === null || (Number.isInteger(maxNumerico) && maxNumerico >= 0 && maxNumerico <= 1000);

  function motivoDaRecusa(r: Extract<UpdateMetaSignupResult, { ok: false }>): string {
    if (ehRecusaDeEscrita(r.error)) return t(MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error]);
    if (r.error === "empresa_nao_encontrada") return t("Empresa não encontrada.");
    if (r.error === "invalid_input") return t("Confira os valores: o limite é um número inteiro, de 0 a 1000.");
    return `${t("Não deu para salvar, e nada foi gravado.")} ${t(r.error)}`;
  }

  function salvar() {
    iniciar(async () => {
      const r = await definirAcessoDaEmpresaNaMeta({
        organization_id: props.organizationId,
        embedded_signup: doEstado(signup),
        coexistencia: doEstado(coex),
        max_numeros: maxNumerico,
      });
      if (!r.ok) {
        toast.error(motivoDaRecusa(r));
        return;
      }
      toast.success(t("Liberação salva."));
      router.refresh();
    });
  }

  if (props.bancoSemATabela) {
    return (
      <Card className="p-4 text-sm" data-testid="acesso-sem-tabela">
        {t("Este banco ainda não tem a migration 9452. Rode a atualização da instalação para liberar o canal oficial por empresa.")}
      </Card>
    );
  }

  const rotuloDoPadrao = props.padraoDaInstalacao ? t("liberado") : t("bloqueado");

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {props.leituraFalhou ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted">
          {t("Não deu para ler a liberação salva agora, então o que aparece pode não ser o que está valendo. Recarregue a página antes de trocar qualquer coisa.")}
        </p>
      ) : null}

      {!props.appConfigurado ? (
        <p data-testid="acesso-app-nao-configurado" className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          {t("O app da Meta da instalação ainda não tem App ID e ID de configuração. Liberar aqui só tem efeito depois que eles forem cadastrados em")}{" "}
          <Link href="/admin/meta" className="font-medium underline underline-offset-2">
            {t("API Oficial (Meta)")}
          </Link>
          .
        </p>
      ) : null}

      <Card className="flex flex-col gap-4 p-4">
        <div>
          <h2 className="font-medium">{t("Canal oficial desta empresa")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Define o que esta empresa pode fazer com a API Oficial. Os números já conectados continuam funcionando se você bloquear — o bloqueio vale para conectar novos.")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="acesso-signup">{t("Conectar pela janela da Meta (Embedded Signup)")}</Label>
          <Seletor id="acesso-signup" valor={signup} aoMudar={setSignup} rotuloDoPadrao={rotuloDoPadrao} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="acesso-coex">{t("Coexistência com o app WhatsApp Business")}</Label>
          <Seletor id="acesso-coex" valor={coex} aoMudar={setCoex} rotuloDoPadrao={rotuloDoPadrao} />
          <p className="text-xs text-muted-foreground">
            {t("Só vale se a conexão pela janela da Meta também estiver liberada.")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="acesso-max">{t("Limite de números oficiais")}</Label>
          <Input
            id="acesso-max"
            data-testid="acesso-max"
            inputMode="numeric"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            placeholder={t("Em branco = vale só o limite do plano")}
            className="max-w-xs"
          />
          <p className="text-xs text-muted-foreground">
            {t("Vale em cima do limite do plano: o menor dos dois manda. Zero bloqueia novos números.")}
          </p>
        </div>

        <div className="flex items-center justify-end">
          <Button data-testid="acesso-salvar" disabled={!maxValido || ocupado} onClick={salvar}>
            {ocupado ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
