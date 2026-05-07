#!/bin/sh
set -e

# If no args, or the first arg is a flag (starts with '-'), assume the user
# wants `witm run` and prepend the subcommand. Otherwise pass through verbatim
# so subcommands like `ca install`, `version`, `plugin add ...` keep working.
if [ "$#" -eq 0 ] || [ "${1#-}" != "$1" ]; then
    set -- run "$@"
fi

exec witm "$@"
