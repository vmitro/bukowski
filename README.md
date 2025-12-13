See the [website](https://bukowski.store/)

## Known Limitations

- **Codex input box background**: Codex uses OSC 10/11 escape sequences to query the terminal's background color and style its input box accordingly. This mechanism does not work through PTY intermediaries (terminal multiplexers), so the input box appears without its colored background when running Codex inside bukowski. This is the same limitation that exists in tmux and other multiplexers - it's a fundamental PTY architecture constraint, not a bug.
