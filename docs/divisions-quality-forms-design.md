# Divisions — Evaluation Forms and Survey Forms

**Status: DESIGN — not built. Awaiting go-ahead. One open question (§4) cannot
be answered from the spec and needs a five-minute experiment on a throwaway
form before this is safe to build.**

Two new pages under **Divisions**, in a new **Quality** group: Evaluation Forms
and Survey Forms. Genesys makes both division aware. Neither is accepted by the
bulk division endpoint, so both use the `moveFn` hook that Skills and Wrap-up
Codes already added to [`_generic.js`](../js/pages/divisions/_generic.js).

Everything below is read off the public OpenAPI spec
(`api.mypurecloud.com/api/v2/docs/swagger`), re-verified 2026-09-06.

---

## 1. Why this is not another Libraries

Libraries took ten minutes: `LIBRARY` is on the bulk endpoint's `objectType`
enum, so the page is a wrapper and the move is one POST that Genesys validates.

Forms are the opposite case, and the difference is not cosmetic:

| | Libraries | Wrap-up Codes | Forms |
|---|---|---|---|
| On the bulk enum | yes | no | no |
| Write used | `POST /authorization/divisions/{id}/objects/LIBRARY` | `PUT /routing/wrapupcodes/{id}` | `PUT /quality/forms/{type}/{id}` |
| What the write replaces | nothing — a division assignment | name, description, division | **the entire form, question groups included** |
| Blast radius if the body is wrong | move fails | description lost | **the form is rewritten** |

That last row is the whole design problem. On Skills, the wrong body did
nothing. Here, the wrong body is a form with its questions replaced.

---

## 2. What is confirmed

Both models carry a writable division, in the ordinary shape — not the flat
`divisionId` that `patchRoutingSkill` turned out to want:

```
EvaluationForm.division -> WritableStarrableDivision  { id, name }
SurveyForm.division     -> WritableStarrableDivision  { id, name }
```

| | Evaluation Forms | Survey Forms |
|---|---|---|
| List | `GET /api/v2/quality/forms/evaluations` | `GET /api/v2/quality/forms/surveys` |
| Read one | `GET .../evaluations/{formId}` | `GET .../surveys/{formId}` |
| Write | `PUT .../evaluations/{formId}` | `PUT .../surveys/{formId}` |
| View permission | `quality:evaluationForm:view` (ANY) | `quality:surveyForm:view` (ALL) |
| Write permission | `quality:evaluationForm:edit` (ANY) | `quality:surveyForm:edit` (ALL) |
| Required on write | `name`, `questionGroups` | `contextId`, `language`, `name` |

The ANY/ALL split is real but moot: each list holds one permission, so the two
quantifiers agree. It matters only if a second permission is ever added.

**There is no division-specific write for forms.** I checked every path in the
spec that writes and touches a division. The only candidates are the two PUTs.

### The survey PATCH is a trap

`PATCH /api/v2/quality/forms/surveys/{formId}` exists, and after the Skills
story the temptation is to read it as the division updater. It is not:

> Disable a particular version of a survey form and invalidates any invitations
> that have already been sent to customers using this version of the form.

It is gated on `quality:surveyForm:disable`. Calling it to set a division would
invalidate live customer survey invitations. **Do not use it.**

---

## 3. The round-trip, and its one asymmetry

A move is GET the form, replace `division`, PUT it back. Surveys round-trip
cleanly — `GET` returns `SurveyForm` and `PUT` accepts `SurveyForm`, the same
model. Evaluations do not:

| | Evaluations | Surveys |
|---|---|---|
| GET returns | `EvaluationFormResponse` | `SurveyForm` |
| PUT accepts | `EvaluationForm` | `SurveyForm` |
| Difference | Response has `weightMode`; Form has `redacted` | none |

So the evaluation body must have `weightMode` stripped before the PUT. Genesys
publishes an `invalid.property` error — "Value [%s] is not a valid property for
object [%s]" — so sending it back is a plausible 400. Untested; strip it.

`SurveyForm.contextId` is both **required** and **readOnly**. Round-tripping the
value the GET returned satisfies both readings; inventing one would not.

### Nested ids must be preserved

[`onboarding-runner/lib/processor.js`](../onboarding-runner/lib/processor.js)
already strips forms for cross-org copy, deleting `id`, `contextId`,
`modifiedDate`, `publishedVersions`, `redacted`, `selfUri`, `division` **and
every nested question id**. That is the correct shape for *create in another
org* and the exact wrong shape here: an in-place PUT that drops nested ids
replaces the questions instead of updating them. Read it as precedent; do not
reuse it.

---

## 4. Open question — what happens to published versions

Forms are versioned. `publishedVersions`, the `/versions` endpoints and the
separate `publishedforms` resources all exist, and published forms carry their
own division — `GET /quality/publishedforms/evaluations/divisionviews` accepts a
`divisionId` filter, which it would not if published versions were division-free.

Two things follow that the spec cannot answer:

1. **Does moving the editable form move its published versions?** If not, a
   "move" is half a move: the draft sits in the new division and the published
   version agents actually use stays in the old one.
2. **Does PUT against a published form create a new version, or unpublish it?**
   If a division change silently spawns a version, a bulk move across 40 forms
   quietly rewrites the org's form history.

**The experiment**, on one throwaway form in the demo org, before any code:

- create a form, publish it, note `publishedVersions` and its division
- PUT it back with only `division` changed
- re-read the form, `/versions`, and the matching `publishedforms` entry
- record: did the published version move, did a new version appear, is the form
  still published

If published versions do not follow, the design must either move them too or say
plainly on the page that it moves the editable form only. Silence is not an
option — an admin who moves a form and sees the old division still enforced will
reasonably conclude the tool lied.

---

## 5. Proposed design

Two wrappers over `_generic.js`, one `moveFn` each, in a new nav group.

```
Divisions › Quality › Evaluation Forms   divisions.quality.evaluationForm
Divisions › Quality › Survey Forms       divisions.quality.surveyForm
```

`moveFn`, per form (the apply loop is already per-item):

1. `GET` the form fresh. Do not move the object the list handed back — list
   responses routinely omit heavy fields, and `questionGroups` is the heaviest
   thing on a form.
2. **Guard:** if the GET returned no `questionGroups`, abort that form with
   "could not read the form's questions — not moving it". A PUT built from a
   partial read is how a form gets emptied. This guard is the single most
   important line in the feature.
3. Build the body from the GET, strip `weightMode` (evaluations), set
   `division: { id: targetId }`.
4. `PUT` it.
5. **Read back**, as Skills does — but check more than the division: confirm the
   question-group count and ids match what went in. A move that lands the
   division and loses a question group must report as a failure, loudly.

New helpers in [`genesysApi.js`](../js/services/genesysApi.js):
`fetchAllEvaluationForms`, `fetchAllSurveyForms`, `fetchEvaluationForm`,
`fetchSurveyForm`, `putEvaluationForm`, `putSurveyForm`. None exist today; the
only form code in the repo is the onboarding runner's survey helpers.

Columns: Name, plus Published (both models carry `published`) so an admin can
see which forms the versioning question actually applies to.

---

## 6. Files

| File | Change |
|---|---|
| `js/pages/divisions/evaluationForm.js` | new |
| `js/pages/divisions/surveyForm.js` | new |
| `js/services/genesysApi.js` | six helpers |
| `js/navConfig.js` | new Quality group, two leaves |
| `js/pageRegistry.js` | two routes |
| `js/accessConfig.js` | two access keys in the doc list |
| `js/featurePermissionMap.js` | two entries |
| `docs/setup-guide.md` | two test-matrix rows, feature bullet, file tree |
| `README.md` | feature bullet, file tree |
| `docs/customer-facing-plan.md` | two permission rows |
| `js/releaseNotes.js` | one entry covering both pages |

`divisions.*` already covers the new keys in `GROUP_ACCESS` and in the
`user-access` package, so no entitlement change is needed.

---

## 7. Test plan

Beyond the two standard rows (load, filter, move, results):

- move a **published** form and check the published version afterwards — this is
  §4 turned into a permanent test
- move a form with several question groups, then reopen it in Genesys and
  confirm the questions, weights and answer options are unchanged
- move the same form twice without reloading
- an evaluation form and a survey form, since only one of them needs the
  `weightMode` strip
- a user holding `quality:evaluationForm:view` but not `:edit` sees the page and
  cannot apply

---

## 8. One licensing note

`quality:evaluationForm:edit` and `quality:surveyForm:edit` are both on the
Hourly Interacting disqualifying list
([`hourlyDisqualifyingPermissions.js`](../js/lib/hourlyDisqualifyingPermissions.js)).
Granting either to a customer user costs them Hourly Interacting eligibility.
Worth stating on the customer-facing side before anyone buys the module.

---

## 9. Decision needed

1. Run the §4 experiment first — yes, or build against the assumption that
   published versions follow the form?
2. If published versions do **not** follow: move them too, or state the limit on
   the page?
3. Two pages in a new Quality group, as proposed?
