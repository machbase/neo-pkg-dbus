# neo-pkg-dbus

neo-pkg-dbus collects values exposed by a Linux D-Bus service and stores them in Machbase Neo tables.

## What you can do

- Create and manage collection Jobs.
- Configure D-Bus calls, inputs, output values, and table mapping.
- Start and stop Jobs from the Job list.
- Monitor the latest run, skipped scheduled cycles, and stored data.
- Change the active log level, view live logs, and browse saved log files.

Each Job runs on its configured time boundary. If a scheduled cycle arrives while the previous cycle is still running, the cycle is skipped and shown in the Job monitoring view. The reset icon beside the skip notice clears only this monitoring counter; it does not restart collection.

Use the package page in Machbase Neo to configure and operate the collector. Detailed development, build, package lifecycle, and API notes are kept in [the development guide](docs/DEVELOPMENT.md).
