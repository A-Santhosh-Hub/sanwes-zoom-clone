# Game Hub input helper

`sanwes-input.cs` is this project's own program (keyboard, mouse and virtual gamepad commands for viewers the streamer approved).
`npm run setup` (Windows) builds it into `sanwes-input.exe` with the compiler that comes with Windows. **No .exe or .dll is stored in this repository.**

## Nefarius.ViGEm.Client.dll (fetched by setup, not stored here)
- What: managed client library for the ViGEmBus driver (virtual Xbox 360 / DualShock 4 controllers).
- Source: the official NuGet package `Nefarius.ViGEm.Client` 1.21.256 from nuget.org (https://github.com/ViGEm/ViGEm.NET).
- Package SHA-256 (checked by setup): FF460031B33E0882CD1166FE2D072D0FE97578480C61ED85DCCFA6C930FDB55E
- Licence: MIT, Copyright (c) Nefarius Software Solutions e.U. 2017-2023.
- It needs the **ViGEmBus** driver on the computer that streams (https://github.com/nefarius/ViGEmBus). The driver is a separate, signed Windows driver;
  this project does not include or install it. Without it, keyboard and mouse play still works and only gamepads are unavailable.
