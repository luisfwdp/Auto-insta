# Fontes CRIA PING

Sora e Inter oficiais, hospedadas por `next/font/local`, `display: swap`, sem preload no layout legado. Subsets WOFF2 variáveis: Sora ~41 KiB e Inter ~141 KiB. Sem dependência npm nova; build e navegador não consultam Google Fonts.

Origem: repositório [google/fonts](https://github.com/google/fonts), diretórios `ofl/sora` e `ofl/inter`, arquivos `Sora[wght].ttf` e `Inter[opsz,wght].ttf`, obtidos em 22/10/2026. Licenças completas em `Sora-OFL.txt` e `Inter-OFL.txt`.

Subsets feitos com fontTools + Brotli (ferramentas temporárias, fora do runtime): Unicode U+0000–024F, U+2000–206F, U+20AC, U+2122, U+2192 e U+2713. Incluem acentos do português; chinês usa fallback do sistema. Pesos variáveis preservados. Títulos usam Sora 600/700; texto usa Inter 400/500.

SVGs em `public/brand/criaping`: símbolo vetorial próprio a partir da referência autorizada; wordmarks em contornos Sora 700 e assinatura Inter 400 para renderização independente de fontes. Cor oficial solicitada em texto: `#C7FF2F` (a imagem tem variações por rasterização). Não trocar para a cor amostrada da imagem.
