import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Termos de Uso — PING CHAT",
  description:
    "Termos para usar o PING CHAT, serviço de automação de comentários e mensagens no Instagram.",
};

export default function TermsPage() {
  return (
    <LegalShell
      title="Termos de Uso"
      description="Estes termos definem as regras de uso do PING CHAT."
      updatedAt="23 de novembro de 2026"
    >
      <section>
        <h2 className="text-xl font-bold text-foreground">Uso autorizado</h2>
        <p className="mt-3">
          Você só pode usar o PING CHAT com contas profissionais do Instagram que sejam suas ou que você esteja autorizado a administrar. Você é responsável pelas campanhas, palavras-chave, links e mensagens que configurar.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Regras da plataforma</h2>
        <p className="mt-3">
          Você se compromete a seguir os Termos da Plataforma da Meta, as políticas do Instagram, as regras de mensagens, a LGPD, as normas de publicidade e as leis contra spam. O PING CHAT pode limitar, pausar ou desativar campanhas que criem risco de abuso, de segurança, de descumprimento de regras ou de bloqueio da conta.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Teste grátis, assinatura e cancelamento</h2>
        <p className="mt-3">
          O teste grátis dura 72 horas a partir da ativação e não exige cartão. As assinaturas são mensais, cobradas pelo Asaas no valor mostrado na página de preços, com renovação automática até o cancelamento.
        </p>
        <p className="mt-3">
          Você pode cancelar a renovação a qualquer momento na área de assinatura. O acesso continua até o fim do período já pago. Cada plano tem limites de contas, membros, mensagens, publicações e armazenamento, informados na página de preços.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Disponibilidade</h2>
        <p className="mt-3">
          O PING CHAT depende de serviços de terceiros, como Meta, e-mail, hospedagem, banco de dados e filas. Trabalhamos para manter o serviço estável, mas não garantimos funcionamento ininterrupto. Mudanças nas regras ou na API da Meta podem alterar ou limitar recursos.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Contato</h2>
        <p className="mt-3">
          Dúvidas sobre estes termos: <a className="underline" href="mailto:contato@pingchatbr.app">contato@pingchatbr.app</a>.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Código aberto</h2>
        <p className="mt-3">
          O PING CHAT é baseado no OpenReply, projeto de código aberto sob licença MIT. A infraestrutura hospedada, o suporte e os recursos pagos do serviço são oferecidos separadamente do código aberto.
        </p>
      </section>
    </LegalShell>
  );
}
