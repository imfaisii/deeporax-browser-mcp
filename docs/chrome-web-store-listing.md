# Chrome Web Store listing copy

Kept here so the published listing and the repo cannot drift apart.

## Why this wording

An earlier version listed seven AI tools and editors by name. The Web Store
rejected it as keyword spam (violation reference "Yellow Argon"). A run of
third-party product names reads as stuffing regardless of intent, and naming
other companies' products to attract their search traffic invites a separate
complaint. Compatibility is now stated by protocol, which is accurate and does
not lean on anyone else's brand.

Two other rules this copy follows: no claim that data stays private, because
page content does travel to whichever AI service the user has connected, and no
repetition of the same phrase for search weight.

## Short description (132 characters max)

```
Let an AI assistant read and control the browser you already use, through a
server running on your own machine.
```

## Detailed description

```
Deeporax Browser MCP connects your browser to AI assistants that speak the
Model Context Protocol, so an assistant can read the page you are on and act
on it the way you would.

It drives the browser you already use, with your profile and the sessions you
are already signed in to, instead of launching a separate automated browser
that knows none of that.

What an assistant can do once connected:

- Read the page as a structured outline of its headings, links, buttons and
  form fields, including content inside web components that a normal script
  cannot reach
- Capture the visible area or the whole page as an image
- Click, type, select options, drag and press keys. Input is delivered through
  the browser's own input pipeline, so pages built on component libraries
  respond to it exactly as they respond to a person
- Navigate, manage tabs, and move back and forward through history
- Read console output and network activity, which is useful when debugging a
  site you are building
- Fill forms field by field, with every field read back afterwards so a value
  that did not take is reported rather than assumed

While a tool is acting, an overlay on the page shows what is happening and
gives you a stop button.

How it works

The extension does nothing on its own. It connects to a small server you run
on your own machine, and only that server can send it instructions. Nothing
happens unless you start the server and ask your assistant to do something.

Page content and screenshots are sent to the assistant you connect, in the
same way anything you paste into that assistant is. Choose what you point it
at accordingly, and use the stop button whenever you want it to halt.

Chrome will show a banner saying the extension has started debugging the
browser. That is expected: it is how the extension delivers real input and
takes screenshots, and it is Chrome telling you the truth about what is
happening. Dismissing it stops the extension from acting.

The project is open source. Setup instructions are in the repository linked
below.
```

## If the reviewer asks for a resubmission note

```
The previous description listed several third-party AI tools and editors by
name. That has been removed. Compatibility is now described by the protocol
the extension implements, without naming other products.
```
