# NeonOS

Sistema operacional leve com interface cyberpunk, baseado no **Debian 13 "trixie"** (a mesma base do LMDE 7), com o kernel Linux do Debian, bash e Firefox.

## Estrutura

| Pasta | O que tem |
|---|---|
| `neonos/` | A interface (HTML/CSS/JS) e o backend `server.py`, que liga a interface ao Linux (bash, arquivos, rede, som, energia, apt) |
| `iso/` | Configuração do live-build e o script que gera a ISO |

## Rodar a interface no computador (para desenvolver)

```bash
python3 neonos/server.py
```

Depois abra http://localhost:8080. Fora do Linux, Wi-Fi, som, brilho, loja e persistência aparecem como indisponíveis. No modo de desenvolvimento, a senha da tela de bloqueio é `live`.

## Gerar a ISO

Precisa do Docker. Funciona no macOS (inclusive Apple Silicon, por emulação), no Linux e no Windows com WSL.

```bash
./iso/build.sh
```

O resultado fica em `iso/out/neonos-amd64.iso`. Grave num pendrive com o balenaEtcher ou com o Rufus (modo DD).

## No sistema

- Usuário `ghost`, senha `live` (no modo live)
- Super+Espaço volta para a interface · Super+B abre o navegador · Alt+Tab troca de janela
- Ctrl+Alt+L bloqueia a tela · Ctrl+Alt+F2 abre um terminal de texto
- `neon-notify "título" "texto"` mostra uma notificação

## Animações ASCII

- **Motor:** `neonos/ascii.js`, com 8 efeitos: chuva digital, donut 3D, fogo neon, plasma, túnel, hiperespaço, cidade na chuva e radar
- **Onde aparecem:** boot com logo que decodifica e fluxo hexadecimal, logo da área de trabalho com glitch e letreiro, títulos que decodificam, janelas que se desfazem em blocos, notificações, bloqueio com donut 3D e relógio em blocos, protetor de tela, papéis de parede ASCII, radar e barras no Implante, visualizador ASCII no Player, animação de desligar estilo CRT
- **App ASCII Lab:** mostra todos os efeitos (setas ←/→ trocam)
- **Config → Animações:** nível (completo, reduzido ou desligado) e protetor de tela
- **No terminal:** `neon` (`banner`, `rain`, `donut`, `fire`, `plasma`, `tunnel`, `hack`, `all`), e `neofetch` com o logo fantasma

## Atualizações

- **Debian** (kernel, Firefox, drivers, programas): pelo apt. Na interface, use **Config → Atualizações → Atualizar tudo**. O Debian renova a lista sozinho uma vez por dia, e a interface avisa quando há atualizações.
- **Interface NeonOS:** `neon-update` baixa a versão nova do repositório no GitHub (configurado em `/etc/neonos/update.conf`, ou pela própria aba Atualizações).
  - Só atualiza se `neonos/VERSION` no repositório for maior que a versão instalada. **Lembre de aumentar esse número a cada versão nova.**
  - Guarda os 3 últimos backups em `/var/backups/neonos` (`sudo neon-update --rollback` volta para o anterior).
  - Configurações do usuário (`/etc/skel`): se você não mexeu num arquivo, ele é trocado pelo novo; se mexeu, o seu é mantido e o novo fica ao lado como `.neonos-novo`.
  - Programas novos da lista `iso/config/package-lists/neonos.list.chroot` são instalados automaticamente.

## Steam

Vem pré-instalada (`steam-installer` + bibliotecas de 32 bits). Na primeira abertura, ela baixa a própria atualização (~300 MB) e pede para entrar na conta, onde você aceita o acordo de assinante da Valve.

## Monitores (Super+P)

- `neonos/neon-display` usa o `wlr-randr` para os modos **Só a tela principal**, **Duplicar**, **Estender** (padrão) e **Só a segunda tela**. O modo escolhido fica salvo em `~/.config/neonos/display.json` e é reaplicado no login.
- No modo Estender, a janela da interface cobre todos os monitores: o `neon-display shell-rule` reescreve a regra `neonos-shell` do `rc.xml` com o tamanho total. A página recebe o layout por `/api/displays` e desenha um papel de parede por monitor. A barra de tarefas e os ícones ficam no monitor principal, e maximizar ocupa só o monitor da janela.
- Super+P (atalho do labwc) abre o menu. Também está em Config → Monitores.

## Cursor

O tema **Neon** (`/usr/share/icons/Neon`) é gerado por `iso/cursor/make-cursors.py`, que usa python3-pil e xcursorgen. As cópias em PNG ficam em `neonos/cursors/` e são usadas pela interface.
