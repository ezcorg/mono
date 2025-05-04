
# Testing + CI/CD

## Best practices

* GitHub Actions should only ever make simple calls to existing CLIs in the repository (to avoid messy and overly complicated YAML files).
* CLIs are always preferred to shell scripts, as they are easier to test and maintain, allow code-reuse, are more readable, and should offer type safety. Unless absolutely necessary, shell scripts should not be used in the repository.
* Good CLI libraries (types -> parsed+validated command line arguments):
  * Rust -> [Clap](https://docs.rs/clap/latest/clap/) or [Twelf](https://docs.rs/twelf/latest/twelf/)
  * Python -> [Typer](https://typer.tiangolo.com/)
  * Golang -> [Cobra](https://github.com/spf13/cobra)/[Viper](https://github.com/spf13/viper)
  * Typescript -> [Pastel](https://github.com/vadimdemedes/pastel) or ...? #todo
  * Ruby -> ..? #todo
* Only run tests and builds that are relevant to the code that has changed
* Cache everything
* Write tests that are parallelizable, and prefer integration tests over unit tests
  * Tests that require a connections to external resources are responsible for constructing their own test environment, and should not rely on the CI/CD environment to provide it.
  * Tests should be written in a way that they can be run in parallel, and should not rely on any shared state. While annoying, this is likely closer to how the code will be run in production, and will help catch bugs that would otherwise be missed.

# Infrastructure

## Requirements

* No vendor lock-in. We should be able to move our infrastructure to any provider at any time, and we should not be dependent on any one provider for any critical service.
* No `Terraform`.

## Best practices

* Where possible, dogfood our own tools, and use them to manage our infrastructure.
* Cattle, not pets. Assume that anything can be destroyed or fail at any time (but consider the cost of handling such an event relative to the frequency with which it may occur).


# Data

## Requirements

* Business data should be accessible to all employees, and should be stored in a way that is easily queryable.
* Any other data access should be limited to only those who need it, and should be logged and audited.
* Data write access is limited to service accounts. Having the ability to assume the service account should be limited to only those who need it, and should be logged and audited.
* Access to sensitive data (up to confidential) should be granted in a self-serve way, and should be automatically revoked after a certain period of time (e.g. 30 days).
* Application data should not be queried directly (no SQL queries against production databases), and should instead be accessed through anayltical datastores after being ETL'd.

## Best practices

* Data should be stored in a way that is easily queryable, and should be indexed where appropriate.
* Data should be stored in a way that is easily exportable, and should not be locked into any proprietary format.

# Business vendors

## Requirements

* Any third-party vendor that we use must provide a real-time mechanism for us to export our data in a format that is not proprietary, such that we can ingest our data into our own systems and migrate if at any point we need to. A promise of building a feature in the future does not count.
* May not retain or use our data for any purpose other than providing the service that we are paying them for.
* Must provide a way for us to delete our data at any time, and must do so in a timely manner.

## Preferences

* Prefer vendors that are open-source, or at least have a source-available version of their software.
* Prefer vendors that are based in Canada, the EU, and/or regions without a culture of exploitative and harmful business practices.