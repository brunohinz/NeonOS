# NeonOS

Sistema operacional completo com interface cyberpunk, baseado no **Debian 13 "trixie"** (a mesma base do LMDE 7), com o kernel Linux do Debian, bash e Firefox.

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


Em Config → Monitores dá para arrumar a posição física no "Estender" (qual monitor fica à esquerda/direita ou em cima/embaixo, e o alinhamento), para o mouse passar de um para o outro pelo lado certo. Fica salvo em `~/.config/neonos/display.json` (`neon-display arrange A,B row|column top|center|bottom`).
## Cursor

O tema **Neon** (`/usr/share/icons/Neon`) é gerado por `iso/cursor/make-cursors.py`, que usa python3-pil e xcursorgen. As cópias em PNG ficam em `neonos/cursors/` e são usadas pela interface.

## Sistema completo (0.6)

A interface do NeonOS convive com apps nativos (Steam, LibreOffice, apps do Flathub):

- **Barra de tarefas** mostra as janelas dos apps nativos com o ícone de cada um (clique alterna/minimiza, botão direito fecha ou maximiza). Clicar na área de trabalho não esconde os apps abertos. A lista vem do protocolo wlr-foreign-toplevel do labwc, lido por `neonos/wl.py` (um cliente Wayland em Python puro).
- **Menu iniciar** (tecla Windows) com busca: apps do NeonOS, todos os apps instalados e atalhos de configuração. Botão direito num app: fixar na área de trabalho ou abrir ao ligar.
- **Arquivos**: seleção múltipla, copiar/recortar/colar, arrastar e soltar, lixeira com restaurar, busca nas subpastas, lista ou grade, miniaturas, compactar em .zip, extrair (zip, tar, 7z, rar...), propriedades, "Abrir com…", pendrives e outros discos (montados sozinhos ao conectar, com ejetar).
- **Apps padrão**: pastas, textos, imagens e mídia abrem no NeonOS (`neon-open`); PDF no Evince, documentos no LibreOffice. Dá para trocar em Config → Apps padrão ou em "Abrir com…".
- **Loja** com o Flathub (Discord, Spotify, OBS, Heroic, Bottles...) instalando por usuário, sem senha, e os pacotes do Debian. Programas → botão direito → Desinstalar.
- **Config**: Bluetooth, impressoras e scanner, energia (modo de desempenho, desligar tela, suspender, luz noturna), teclado e fuso horário, apps padrão e inicialização, drivers (instala o da NVIDIA), firewall, troca de senha, atualizações do Flathub, hardware e backup (Timeshift).
- **Tarefas** (Ctrl+Shift+Esc): processos com finalizar/forçar e janelas abertas.
- Drivers e firmware de Wi-Fi, vídeo, som e Bluetooth, codecs, impressão, LibreOffice, VLC, leitor de PDF, calculadora, discos, emoji e fontes compatíveis com o Office já vêm na ISO.

### Tema neon dos apps nativos

`/usr/share/themes/NeonOS` tem o tema GTK 3 (LibreOffice, Discos, impressoras, Bluetooth, Timeshift e, pelo platformtheme gtk3, os apps Qt como o VLC) e o GTK 4. Os apps libadwaita (Calculadora, Digitalizador) recebem as cores pelo `~/.config/gtk-4.0/gtk.css`. O nome do tema vem do dconf (`/etc/dconf/db/local.d/00-neonos`), que é o que o GTK lê no Wayland.

### Atalhos

| Tecla | Ação |
|---|---|
| Windows | menu iniciar com busca |
| Super+E | arquivos |
| Super+D | mostrar a área de trabalho |
| Super+L | bloquear |
| Super+P | monitores |
| Super+Espaço | trazer a interface NeonOS para frente |
| Super+Enter | terminal |
| Print / Shift+Print / Super+Shift+S | capturar a tela / uma área |
| Super+Shift+R | gravar a tela (de novo para parar) |
| Ctrl+Shift+Esc | gerenciador de tarefas |
| Alt+Tab | alternar janelas |

O `rc.xml` do labwc é recriado a cada login a partir de `/usr/share/neonos/labwc/rc.xml`, para que atualizações tragam atalhos novos. Para editar à mão, coloque um comentário `neonos:manual` nele.
