import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Exclusão de Dados — PING CHAT",
  description:
    "Como desconectar o Instagram e pedir a exclusão de conta, espaço de trabalho e dados de campanhas no PING CHAT.",
};

export default function DataDeletionPage() {
  return (
    <LegalShell
      title="Exclusão de Dados"
      description="Veja como desconectar o Instagram e como pedir a exclusão dos seus dados no PING CHAT."
      updatedAt="23 de novembro de 2026"
    >
      <section>
        <h2 className="text-xl font-bold text-foreground">Desconectar o Instagram</h2>
        <p className="mt-3">
          Entre na sua conta, abra Configurações e escolha Desconectar. Isso remove o token de conexão guardado e interrompe o envio de respostas e mensagens daquela conta.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Excluir conta e espaço de trabalho</h2>
        <p className="mt-3">
          Para excluir a conta, o espaço de trabalho, campanhas, registros de envio e demais dados, escreva para <a className="underline" href="mailto:contato@pingchatbr.app">contato@pingchatbr.app</a> a partir do e-mail usado no cadastro. Informe o nome do espaço de trabalho e o usuário do Instagram conectado.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Excluir dados de quem comentou ou recebeu mensagens</h2>
        <p className="mt-3">
          Se você interagiu com uma conta que usa o PING CHAT e quer acessar ou excluir seus dados, escreva para <a className="underline" href="mailto:contato@pingchatbr.app">contato@pingchatbr.app</a> informando o seu usuário do Instagram e a conta com a qual interagiu. Encaminhamos o pedido ao responsável por aquela conta e executamos a exclusão.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Verificação e prazo</h2>
        <p className="mt-3">
          Podemos pedir que você confirme o controle do e-mail ou da conta do Instagram antes de excluir. Respondemos em até 15 dias. Alguns registros podem ser mantidos quando a lei exigir, por exemplo dados fiscais e de cobrança, ou para prevenir fraude e garantir a segurança.
        </p>
      </section>
    </LegalShell>
  );
}
