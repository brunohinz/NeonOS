# ~/.bashrc do NeonOS
case $- in *i*) ;; *) return ;; esac

HISTCONTROL=ignoreboth
HISTSIZE=5000
HISTFILESIZE=10000
shopt -s histappend checkwinsize globstar 2>/dev/null

[ -f /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion

alias ls='ls --color=auto'
alias ll='ls -lah'
alias grep='grep --color=auto'
alias neofetch='fastfetch'
alias matrix='neon rain'
alias donut='neon donut'

# prompt neon: usuário@neon:pasta ❯
PS1='\[\e[38;2;255;42;109m\]\u\[\e[38;2;93;122;153m\]@\[\e[38;2;255;42;109m\]\h\[\e[0m\]:\[\e[38;2;0;240;255m\]\w\[\e[0m\] \[\e[38;2;245;230;99m\]❯\[\e[0m\] '

# no terminal de texto (Ctrl+Alt+F2), mostra o logo animado uma vez
if [ "$TERM" = "linux" ] && [ -z "$NEON_BANNER_SHOWN" ] && command -v neon >/dev/null; then
  export NEON_BANNER_SHOWN=1
  neon banner
fi
