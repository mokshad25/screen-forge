# ScreenForge

Runtime HMI screen generator for industrial operators. Describe what you need to
watch, by text or voice, and get a live, validated, read-only monitoring screen
laid out for a 7", 10" or 15"+ panel.

The model never writes UI. It emits a small JSON screen spec; a three-layer
validator checks it against the machine's real tag list; a deterministic layout
engine renders it.

> v1 was co-built with Kostubh Kumar at the Schneider Electric SMART HMI
> Innovation Marathon (SRM Chennai, Sep 2026), where it reached the final round.
> This repository is the v2 rebuild by Mokshad Kanaujia.
