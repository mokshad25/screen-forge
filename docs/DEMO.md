# Demo script (5 minutes)

Before: `docker compose up --build` (live plant), open http://localhost:3000,
click **Close screen** if one is open, and reset the plant (**Plant controls**,
or `curl -XPOST localhost:8090/reset`). Have UaExpert open on
`opc.tcp://localhost:4840/screenforge` if you want to show the server itself.

## 1. The premise (30 s)

"Operators need screens that nobody built in advance. ScreenForge builds them
on request, but the model never writes UI: it returns a small JSON spec, which
is validated against the machine's real tags and rendered deterministically."

Open **Spec** in the right panel at any point to show the whole JSON.

## 2. Ask for a screen (60 s)

Chiller 1, type: *condenser pressure keeps spiking, give me what I need to watch it*.

- Point at the progress strip: each stage is reported by the API as it happens,
  not on a timer.
- Switch **7"**, **10"**, **15"+**, then **All three**. One spec; the 7" panel
  shows only priorities 1–3 and says what it left out.

## 3. Refuse a control request (20 s)

Type: *drop the compressor speed a bit*. It is refused before any model call,
in plain words, with what it can show instead.

## 4. Edit it (40 s)

Switch to **Edit this screen**: *make the trend bigger and add evaporator
pressure*. The changed components are outlined; **Spec** lists the diff.
**Save screen** puts it in the library.

## 5. An alarm, live over OPC UA (60 s)

**Plant controls**, pick *Condenser pressure*, **Inject fault**. Within a
second the alarm raises: the top bar, the machine list and the alarm list all
show it, and a toast says the troubleshooting screen is ready. **Open alarm
screen**:

- The indicator's pointer is past the limit mark on the real 0–16 bar range.
- Evaporator pressure, compressor status and return temperature come from the
  alarm's playbook in the machine context.
- The comparison trend puts both pressures on one axis.
- No model was used: same alarm, same screen, every time.

**Acknowledge** it: logged locally, nothing is written to the machine.

## 6. Pull a cable (40 s)

**Close screen**, open the **Compressor Trip** alarm screen, then
**Pull Compressor_VFD**. The compressor status goes hatched violet, "bad
quality: last value held"; the link tile reads *Link down*; the top bar shows
*1 link down*. The trip alarm does not fire: a lost link is not a trip.
**Restore**.

## 7. A machine it has never seen (40 s)

**Add a machine from OPC UA**, **Browse**, **Add machine** on AHU 1. Its units,
ranges and alarms come from the server. Open the *Filter Dirty* alarm screen.
Type *is the air handler fan running?* and it is recognised by name with no
code change.

## 8. The machine changes (30 s)

On Chiller 1 with a screen open: **Plant controls**, **Change machine** (a
vibration sensor is fitted). The banner says the screen is out of date and what
is new; **Update screen** rebuilds it keeping what was shown, now with the
High Vibration alarm.

## Questions worth being ready for

- *Why generate screens at runtime when HMIs are engineered in advance?* It is
  for the long tail: diagnostic views nobody built, alarm screens, and drafts
  an engineer saves into the library. The validated primary HMI stays.
- *What if the model binds a valid but wrong tag?* The validator proves it
  exists, not that it is right; the reliability suite measures relevance, and
  edits show their diff. A wrong binding costs a less useful screen, never an
  action on the plant.
- *Plant data to a cloud LLM?* Set `LOCAL_LLM_BASE_URL` and it stays on site.
  Alarm screens never use a model. See SECURITY.md.
