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

## Pushing changes

Clone the repo, make your changes on a branch, and then submit a pull request.

## On `git` submodules

I know they're annoying, and there's not really a ton of get tooling to make them easier to use and manage, but there's not really a better alternative when it comes to managing forks.
