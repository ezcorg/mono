# dev

Polyrepo containing all of the organization's projects and code.

Until such a time that security or other needs require it, this repository is visible to anyone internally, and we should prefer to adopt a "public by default" policy for all code and data.

# Development

```sh
git clone --recursive https://github.com/ezcodelol/dev
# or if you've already cloned it, but are missing submodules
git submodule update --init --recursive
```

## Pushing changes

Fork the repository, make your changes on a branch, and then submit a pull request.

## On `git` submodules

I know they're annoying, and there's not really a ton of get tooling to make them easier to use and manage, but there's not really a better alternative when it comes to managing forks.
