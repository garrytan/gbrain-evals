# Session Memory: Timezone Coordination & Recipe Scaling

## Timezone Situation
- **User location:** US West Coast (PST = UTC−8, or PDT = UTC−7)
- **Melbourne colleague:** Proposed 10 PM AEDT (UTC+11) → converts to **4 AM Pacific** (PDT) or **3 AM Pacific** (PST)
- **London teammate:** Same call lands at **11 AM GMT** — comfortable slot for them
- User accepted the 4 AM slot as "brutal but workable"

### DST Offset Dynamics (AU ↔ US)
| Period | AU Status | US Status | Effect on Offset |
|---|---|---|---|
| Mid-March → Early April | Daylight (AEDT) | Daylight (PDT) | Normal offset |
| Early April → Early October | Standard (AEST) | Daylight (PDT) | Gap shrinks by 1 hour |
| Early October → Early November | Daylight (AEDT) | Daylight (PDT) | Normal offset resumes |

- User has experienced off-by-one-hour sync errors during transition weeks before; plans to mark calendar for those periods
- **Tip noted:** Use a shared world clock link in calendar invites to let apps handle DST adjustments automatically

---

## Recipe Scaling (4 → 6 Servings, ×1.5 multiplier)

| Ingredient | Original | Scaled (×1.5) | US Measure |
|---|---|---|---|
| Flour | 200 g | 300 g | ~2⅓ cups |
| Milk | 120 ml | 180 ml | ¾ cup |
| Butter | 60 g | 90 g | ~6 tbsp (just over ¾ stick) |

- **Oven temperature:** 180 °C = **356 °F → set to 350–355 °F** on a standard home oven

---

## Miscellaneous Notes
- The assistant made an erroneous reference early in the session to a previously scaled recipe and a dinner party — this appears to have been a hallucination of prior context; the actual recipe scaling was done within this session.