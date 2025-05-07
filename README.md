# dev

Polyrepo containing all of the organization's projects and code.

# Development

## Clone the repository

```sh
git clone --recursive https://github.com/ezcodelol/dev
# or if you've already cloned it, but are missing submodules
git submodule update --init --recursive
```

## Getting started

```sh
pnpm -r i && pnpm dev # recursive install and run packages in dev mode
```

## Shipping changes

Push your changes to a separate branch, then submit a pull request to `main`.

## On `git` submodules

I know they're annoying, and there's not really a ton of get tooling to make them easier to use and manage, but there's not really a better alternative when it comes to managing forks.
