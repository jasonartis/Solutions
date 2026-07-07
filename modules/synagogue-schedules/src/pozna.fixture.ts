import type { ScheduleTypeConfig } from './generator'

// Pozna acceptance fixture: the shul's real Shabbos schedule expressed as
// platform rule config, transcribed from the founder's Sheet template formulas
// (client-materials/synagogue/NOTES.md, "Rule capabilities observed").
//
// Template formulas → rules:
//   (1) Mincha Gedolah        = max(EarliestMincha, 1:30 PM)      → notBefore clamp
//   Hadlakas Neiros           = Friday's Candles                  → day-anchored zman
//   (3) Mincha & Kabb. Shabb. = Hadlakas Neiros + 10 min          → line-ref
//   Krias Shema               = Friday's NightShabbos (MOD(6-WEEKDAY) column match)
//   (2) Mincha & Shalosh Seud.= Hadlakas Neiros + 5 min — line-refs resolve only
//       within the same document, and Hadlakas Neiros lives in the Erev Shabbos
//       document, so the Shabbos document re-derives it: Friday's Candles + 5.
//   Maariv Motzei Shabbos     = Saturday's Night50fix / Night60fix

export const poznaShabbosConfig: ScheduleTypeConfig[] = [
  {
    id: 'pozna-erev',
    name: 'ערב שבת',
    nameHebrew: null,
    triggerCondition: { dayTypes: ['erev-shabbat'] },
    span: 'day',
    sections: [
      {
        id: 'pozna-erev-main',
        name: 'Erev Shabbos',
        nameHebrew: null,
        visibilityCondition: {},
        lines: [
          {
            name: '(1) Mincha Gedolah',
            nameHebrew: null,
            rule: {
              // max(EarliestMincha, 1:30 PM) — the template's clamp.
              time: { kind: 'zman', zman: 'MinchaGra', offsetMinutes: 0, notBefore: '13:30' },
            },
          },
          {
            name: 'Hadlakas Neiros',
            nameHebrew: null,
            rule: {
              // Friday's Candles, day-anchored (5 = Friday).
              time: { kind: 'zman', zman: 'Candles', aggregate: { dayOfWeek: 5 }, offsetMinutes: 0 },
            },
          },
          {
            name: '(2) Mincha & Kabbolas Shabbos',
            nameHebrew: null,
            rule: {
              // Same as Hadlakas Neiros in the template (its (3) = Hadlakas Neiros + 10).
              time: { kind: 'zman', zman: 'Candles', aggregate: { dayOfWeek: 5 }, offsetMinutes: 0 },
            },
          },
          {
            name: '(3) Mincha & Kabbolas Shabbos',
            nameHebrew: null,
            rule: {
              time: { kind: 'line-ref', line: 'Hadlakas Neiros', offsetMinutes: 10 },
            },
          },
          {
            name: 'קריאת שמע (ג׳ כוכבים)',
            nameHebrew: null,
            rule: {
              // The template anchors Krias Shema to Friday's NightShabbos.
              time: {
                kind: 'zman',
                zman: 'NightShabbos',
                aggregate: { dayOfWeek: 5 },
                offsetMinutes: 0,
              },
            },
          },
        ],
      },
    ],
  },
  {
    id: 'pozna-shabbos',
    name: 'שבת קודש',
    nameHebrew: null,
    triggerCondition: { dayTypes: ['shabbat'] },
    span: 'day',
    sections: [
      {
        id: 'pozna-shabbos-main',
        name: 'Shabbos',
        nameHebrew: null,
        visibilityCondition: {},
        lines: [
          {
            name: 'סזק"ש מג"א',
            nameHebrew: null,
            rule: {
              time: {
                kind: 'zman',
                zman: 'ShemaMA72',
                aggregate: { dayOfWeek: 6 },
                offsetMinutes: 0,
              },
            },
          },
          {
            name: 'סזק"ש גר"א',
            nameHebrew: null,
            rule: {
              time: {
                kind: 'zman',
                zman: 'ShemaGra',
                aggregate: { dayOfWeek: 6 },
                offsetMinutes: 0,
              },
            },
          },
          {
            name: '(1) Mincha Gedolah',
            nameHebrew: null,
            rule: {
              time: {
                kind: 'zman',
                zman: 'MinchaGra',
                aggregate: { dayOfWeek: 6 },
                offsetMinutes: 0,
                notBefore: '13:30',
              },
            },
          },
          {
            name: '(2) Mincha & Shalosh Seudos',
            nameHebrew: null,
            rule: {
              // Template: Hadlakas Neiros + 5. That line is in the Erev Shabbos
              // document, and line-refs resolve within one document only, so
              // re-derive it here: Friday's Candles + 5.
              time: { kind: 'zman', zman: 'Candles', aggregate: { dayOfWeek: 5 }, offsetMinutes: 5 },
            },
          },
          {
            name: '(1) Maariv Motzei Shabbos (50)',
            nameHebrew: null,
            rule: {
              time: {
                kind: 'zman',
                zman: 'Night50fix',
                aggregate: { dayOfWeek: 6 },
                offsetMinutes: 0,
              },
            },
          },
          {
            name: '(2) Maariv Motzei Shabbos (60)',
            nameHebrew: null,
            rule: {
              time: {
                kind: 'zman',
                zman: 'Night60fix',
                aggregate: { dayOfWeek: 6 },
                offsetMinutes: 0,
              },
            },
          },
        ],
      },
    ],
  },
]
