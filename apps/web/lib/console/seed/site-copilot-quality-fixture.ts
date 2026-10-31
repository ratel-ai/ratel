import type { CapturedRun } from "@/lib/console/seed/site-copilot-quality";

/**
 * The analyst's answers for the Site Copilot quality seed, captured once from a
 * real analysis of the seeded searches (claude-opus-5) and replayed on every later
 * run, so the seed stays deterministic and spends nothing. Regenerate with
 * `make seed-site-copilot-quality CAPTURE=1` (needs ANTHROPIC_API_KEY).
 */
export const SITE_QUALITY_CAPTURED: { earlier: CapturedRun; latest: CapturedRun } = {
  earlier: {
    diagnosis:
      'Most entries describe the record they read instead of the everyday question people ask, so plain requests like "where is the switchgear" or "is the fireproofing still on track" come back empty or land on the wrong tool.',
    points: [
      {
        title: '"Still on track?" goes to the delivery tracker, not the schedule',
        detail:
          'get_project_schedule was the right answer 94 times and we returned it nowhere 39 of those; the losing queries are all the same shape: "is the spray fireproofing still on track", "are we good for the roof membrane on the 16th", "does that push the fireproofing". Its text talks about float, planned and forecast dates, but never says on track, behind, slipped, pushed or will-it-hit-the-date. Meanwhile track_material_delivery opens with the word "Track", so it wins those queries outright; both sides need the distinction written down.',
      },
      {
        title: '"Where is it / when does it arrive" finds nothing',
        detail:
          'track_material_delivery lost 17 searches entirely, nearly all phrased as "where is the switchgear for Harbor Point" or "when does the rooftop units arrive at City Hall Annex". Its searchable text says shipped, in transit, delivered, carrier and ETA, none of which is how anyone asks the question. Adding arrive / get here / where is, plus a few real material names, is the whole fix.',
      },
      {
        title: "Compliance questions get answered with the safety checklist",
        detail:
          'get_subcontractor_compliance missed 13 of its 28 searches, and every example is "is <sub> compliant to start work at <project> Monday"; we led with get_safety_checklist each time, because both entries say "safety" and the checklist entry says "work activity". Neither entry contains the words compliant, cleared, or approved to start work. I have proposed naming the split in both entries, not just the loser.',
      },
      {
        title: "Everything here is a model's opinion, not observed behaviour",
        detail:
          "No search in this window recorded which tool the agent actually ran, so all 477 correct answers came from a judge reading the request against the catalog. That is strong enough to act on (it can name a tool neither engine returned, which is exactly what happened in every case above), but it cannot confirm the agent would have been satisfied. Getting the tool id onto the invocation record would also make the two arms genuinely comparable, which they are not today.",
      },
    ],
    rewrites: {
      get_project_schedule: {
        searchableDescription:
          "Read a project's schedule: activities with planned and forecast dates, float and what each one waits on. Use to answer whether a specific work activity (a deck pour, steel erection, spray fireproofing, roof membrane, site paving) is still on track, on schedule, behind, slipped, pushed or delayed, and whether it will still happen on a given date. Covers start and finish dates, milestones, the critical path, predecessors, and the knock-on effect on later activities when one of them moves. Phrasings: are we good for X on the 16th, is X on track or behind, did that push X, when does X start, has the date moved, will we hit that date. Not for where a material shipment currently is: that is delivery tracking.",
        rationale:
          "Added the on-track, behind and will-it-happen-on-this-date wording, and split it from delivery tracking.",
        details:
          'Fixes the eight shown failures and the wider 39-search gap where we returned this entry nowhere, all judged cases with no invocation data: "Is the spray fireproofing at Lakeview Fire Station on the 21st still on track?", "is the roof membrane on city hall annex on track or behind", "Is the L4 deck pour at City Hall Annex on the 9th still on track?", "Are we good for the roof membrane at Riverside MOB on the 16th?", "Are we good for the steel erection at Eastside Middle School on the 16th?", "Are we good for the spray fireproofing at Northgate on the 16th?", "Is the site paving at Lakeview Fire Station on the 21st still on track?" and "Does that push the spray fireproofing?". Three vocabulary families were missing entirely: the status words (on track, on schedule, behind, slipped, pushed, delayed), the date-commitment phrasing (are we good for X on the 16th, will we hit that date), and the knock-on phrasing (does that push X). Named activity types (deck pour, steel erection, spray fireproofing, roof membrane, site paving) are drawn from the actual failing queries and are the nouns that currently drag these requests toward track_material_delivery. Nothing was deleted: the original sentence is kept verbatim as the first sentence, including float and what each activity waits on. The closing clause names the sibling, because in five of these eight we led with track_material_delivery; the matching clause has been added to that entry so the boundary is stated on both sides.',
        expectedEffect:
          'Schedule-status questions phrased as "on track / behind / good for the 16th" should start returning the schedule instead of the delivery tracker or nothing.',
      },
      track_material_delivery: {
        searchableDescription:
          "Where a material order is right now with the supplier's logistics service: shipped, in transit or delivered, with carrier and ETA. Use when someone asks where is the switchgear, the rebar, the curtain wall panels, the rooftop units or the fire sprinkler pipe, when it will arrive or get here, whether it has left the yard yet, or what the expected arrival date is for a project. Not for whether a scheduled work activity is on track or behind (that is the project schedule), and not for the purchase order record itself, its supplier or its promised date.",
        rationale:
          'Added the "where is it / when does it arrive" wording and separated it from schedule status.',
        details:
          'Fixes the eight shown failures and the wider 17-search blind spot, all judged cases: "Where is the switchgear for Lakeview Fire Station?", "Where is the switchgear for Harbor Point?", "Where is the fire sprinkler pipe for Lakeview Fire Station?", "Where is the curtain wall panels for Riverside MOB?", "Where is the rebar for the level 4 deck for Riverside MOB?", "When does the rooftop units arrive at City Hall Annex?", "When does the rooftop units arrive at Eastside Middle School?", "When does the fire sprinkler pipe arrive at Northgate?". The entry had none of arrive, get here, where is, or arrival date; only the back-office states shipped / in transit / delivered. The five material names come straight from the failing queries. SHORTENING, stated exactly: I dropped the two opening words "Track a delivery" and replaced them with "Where a material order is right now". That is the one deletion, and it is evidence-driven rather than cosmetic: in five of the eight get_project_schedule failures above ("is the roof membrane on city hall annex on track or behind", "Is the L4 deck pour at City Hall Annex on the 9th still on track?", and others) this entry was returned first for a schedule question, and "track" is the term those queries share with it. The word also still lives in the entry name, which is indexed, so matching on it is not lost. Every other phrase is kept: supplier\'s logistics service, shipped, in transit, delivered, carrier, ETA. The two closing clauses name get_project_schedule and get_purchase_order, which is where the 23 wrong-answer appearances most plausibly come from.',
        expectedEffect:
          '"Where is the X" and "when does X arrive" should return the delivery tracker, and it should stop leading on "still on track" schedule questions.',
      },
      get_subcontractor_compliance: {
        searchableDescription:
          "Check a subcontractor's insurance certificate, license and site safety orientation status. Use to answer whether a trade partner, crew or company is compliant, cleared, approved or good to go to start work on site on a given day, and what is missing, expired or out of date. Phrasings: is <company> compliant to start work Monday, are they cleared to mobilize, can they get on site, is their COI current, has their license lapsed, is their orientation done. Not the pre-task safety checklist for a work activity, and not the roster of which subcontractors are on the job.",
        rationale:
          'Added the "cleared to start work" wording and said it is not the pre-task safety checklist.',
        details:
          'Fixes the eight shown failures and the wider 13-of-28 miss rate, all judged cases with no invocation data: "Is Clearview Glass compliant to start work at City Hall Annex Monday?", "Is Summit Interiors compliant to start work at Riverside MOB Monday?", "Is Ironside Erectors compliant to start work at Northgate Monday?", "Is Brightline Electric compliant to start work at Lakeview Fire Station Monday?", "Is Keystone Plumbing compliant to start work at Harbor Point Monday?", "Is Peak Roofing compliant to start work at Northgate Monday?" and two more of the same shape. The entry never contained the words compliant, cleared, approved, mobilize or start work; it only named the three artefacts it reads. We led with get_safety_checklist on every one of these, because that entry owns "safety" plus "work activity"; I have added the reciprocal distinction there. Nothing was deleted; the original sentence is kept verbatim. The final clause also separates this from list_subcontractors, which is the other plausible source of the 37 searches where this entry appeared but something else was right.',
        expectedEffect:
          '"Is <sub> compliant to start work Monday" should return compliance instead of the safety checklist.',
      },
      get_safety_checklist: {
        searchableDescription:
          "Get the pre-task safety checklist for a work activity such as a crane lift, excavation or hot work. Use when someone needs the hazard checklist, job hazard analysis or pre-task plan for a specific task before the crew performs it. Not for whether a subcontractor is compliant or cleared to start work on site: that is their insurance certificate, license and orientation status.",
        rationale:
          "Said this is the task hazard checklist, not a subcontractor's clearance to work.",
        details:
          'This entry is not losing searches of its own, so the only change is the boundary clause. It is the entry we incorrectly led with on all eight shown get_subcontractor_compliance failures ("Is Clearview Glass compliant to start work at City Hall Annex Monday?" and the seven like it), all judged cases. The collision is that it owns both "safety" and "work activity", which is most of what those queries look like semantically. Per the guidance on near-synonym collisions, the distinction is now stated on both sides rather than piling keywords onto the loser alone. Nothing was deleted: the original sentence is kept verbatim and the middle sentence only adds genuine alternative wording for this tool (hazard checklist, job hazard analysis, pre-task plan), which should also help its own recall.',
        expectedEffect:
          "Should stop capturing subcontractor-clearance questions while keeping, or slightly improving, its own pre-task checklist traffic.",
      },
      notify_team: {
        searchableDescription:
          "Post a message to a project's team channel or to the safety manager. Also use to send, forward or pass along a message, note, question or request to a named person or group: the site office, purchasing, the project manager, the superintendent, a foreman, whoever handles it. Phrasings: send this to <person>, can you at least send the request over, let them know, pass it on, tell the team, give them a heads up, flag it to someone, escalate it.",
        rationale:
          "Added the send, forward and pass-it-on wording and the people requests get sent to.",
        details:
          'Fixes the three shown failures and the wider 6-search gap, all judged cases: "Can you at least send the request to the Eastside site office?", "Can you at least send the request to Tom Becker in purchasing?" and "Fine, just pass it on to whoever handles it." The entry only knew the verb "post" and two destinations (team channel, safety manager); none of send, forward, pass on, let them know or escalate appeared, and no human recipient other than the safety manager was named, which is why we led with get_change_order and get_purchase_order on the first two; those queries carry the subject matter but not the action. The destination list (site office, purchasing, project manager, superintendent, foreman, whoever handles it) comes directly from the failing queries. Nothing was deleted; the original sentence stands as the first sentence.',
        expectedEffect:
          'Hand-off requests phrased as "send this to" or "pass it on" should return the notify tool rather than the tool for the topic being discussed.',
      },
      estimate_change_order: {
        searchableDescription:
          "Estimate a change order's cost from its scope, quantities and the current unit rates. Use to price out or re-price a change order by its number, such as CO-015 or CO-038, or from a described scope, and to rerun the estimate under different assumptions: weekend or premium-time overtime, extra crew, a different quantity or a compressed duration. Phrasings: price out CO-038, what would this cost, how much to add, ballpark it, rough order of magnitude, redo the estimate with overtime. Not for reading an existing change order's approved amount, status or backup.",
        rationale:
          'Added "price out", change order numbers, and re-pricing with overtime assumptions.',
        details:
          'Fixes the five shown failures, all judged cases: "Price out CO-038 for Eastside Middle School.", "Price out CO-035 for Lakeview Fire Station.", "Price out CO-015 for Lakeview Fire Station.", "Can you redo CO-029 with weekend overtime?" and "Can you redo CO-022 with weekend overtime?". We returned nothing at all on each. Two gaps: the verb phrases people actually use (price out, re-price, redo the estimate, ballpark, how much to add) were absent, leaving only the formal word "estimate"; and the CO-### identifier pattern never appeared, so a query that is mostly a bare code had almost nothing to land on. The re-run clause (weekend overtime, premium time, extra crew, different quantity) covers the second query shape, where the user is asking for the same estimate under changed assumptions. Nothing was deleted; the original sentence is kept verbatim. The closing clause separates this from get_change_order, which reads the existing record and its approved amount, the most likely source of the 20 searches where this entry appeared but something else was right.',
        expectedEffect:
          '"Price out CO-0xx" and "redo it with overtime" should start returning the estimator instead of nothing.',
      },
    },
  },
  latest: {
    diagnosis:
      'Our tool descriptions say what each tool reads, but not the everyday questions people actually type, so "is the elevator install on track?" and "where is my drywall?" come back empty or land on the wrong tool.',
    points: [
      {
        title: "Schedule questions never reach the schedule tool",
        detail:
          'get_project_schedule was the right answer 114 times and we returned it nowhere in 57 of them. Its text lists "planned and forecast dates, float" but never contains the words people use: on track, behind, delayed, "are we good for the 16th". Worse, the word "track" in those questions drags them to track_material_delivery, which won first place on the elevator-install, roof-membrane and curtain-wall queries.',
      },
      {
        title: "Delivery tracking is written in logistics jargon, not user words",
        detail:
          'track_material_delivery missed 30 of its 91 correct searches, all of them phrased "Where is the precast stair units for Harbor Point?" or "When does the drywall arrive at Eastside Middle School?". The entry says "in transit, carrier and ETA" but never "where is it" or "when does it arrive", and names no actual materials, so several of those searches returned nothing at all from either engine.',
      },
      {
        title: "Subcontractor compliance loses to the safety checklist",
        detail:
          'Every "Is Keystone Plumbing compliant to start work at City Hall Annex Monday?" search went to get_safety_checklist instead, because get_subcontractor_compliance contains the word "safety" but not "compliant" or "cleared to start work". Same for Ironside Erectors, Northair Mechanical, Granite Concrete, Peak Roofing and Clearview Glass. Naming the distinction in the compliance entry should split them cleanly.',
      },
      {
        title: "What this evidence can and cannot tell us",
        detail:
          'No search in this window recorded which tool the agent actually ran, so all 553 correct answers came from a model judge reading the request against the catalog. The good news is that most of these failures are "nobody found it" cases where the incumbent also returned nothing or the wrong tool, so they are real gaps in the wording rather than ranking noise. estimate_change_order\'s single miss ("Price out CO-036") is not a wording problem (its text already says "price out CO-038"), so I left it alone.',
      },
    ],
    rewrites: {
      get_project_schedule: {
        searchableDescription:
          "Read a project's schedule: activities with planned and forecast dates, float and what each one waits on. Use to answer whether a specific work activity (elevator install, curtain wall install, roof membrane, MEP rough-in on a level, interior slab pour, spray fireproofing, steel erection) is on track, behind, slipping or delayed, and whether it will hit a given date. Phrasings: is it on track or behind, are we good for the 14th, will we make that date, is it still on for Monday, how far behind are we, what is the forecast finish, how much float is left, what is this activity waiting on, what is driving the critical path, has the date moved. Covers progress of work on site, not the location of a material shipment.",
        rationale:
          'Added the "on track, behind, are we good for the 14th" wording people actually type.',
        details:
          'Fixes the judged, nobody-found-it cases where we returned this entry nowhere: "Is the elevator install at Eastside Middle School on the 14th still on track?", "Is the elevator install on Riverside MOB on track or behind?", "Is the roof membrane on Eastside Middle School on track or behind?", "Is the curtain wall install at City Hall Annex on the 16th still on track?", "Are we good for the MEP rough-in on level 2 at Lakeview Fire Station on the 9th?", "Are we good for the spray fireproofing at Riverside MOB on the 21st?", "Are we good for the interior slab pour at Lakeview Fire Station on the 16th?" and "Are we good for the curtain wall install at Eastside Middle School on the 14th?". All eight are model-judge cases; four of them returned nothing at all from either engine, and three went to track_material_delivery. The old text carried none of the status vocabulary (on track, behind, slipping, delayed, make the date) and none of the activity nouns the questions are built around, so I added both. I deleted nothing: the original sentence about planned and forecast dates, float and predecessors is kept verbatim as the first sentence, since it is presumably why this entry wins the float and dependency questions I cannot see. The closing clause names the distinction against track_material_delivery; I deliberately phrased it as "location of a material shipment" rather than repeating that entry\'s strongest query words ("where is", "arrive", "ETA") so it disambiguates without stealing those searches.',
        expectedEffect:
          '"On track / behind / are we good for <date>" questions about field activities should start returning the schedule instead of delivery tracking or nothing.',
      },
      track_material_delivery: {
        searchableDescription:
          "Track a delivery with the supplier's logistics service: shipped, in transit or delivered, with carrier and ETA. Use when someone asks where an ordered material or piece of equipment is right now, or when it will land on site: drywall for a level, elevator rails, precast stair units, curtain wall panels, storefront doors, fire sprinkler pipe, structural steel, switchgear, rooftop units. Phrasings: where is it, where are they, when does it arrive, when will it get here, when does it land on site, has it shipped yet, did it leave the plant, is it still coming, what is the tracking status, any tracking number, what is the ETA, is it on the truck. Covers the physical shipment itself, not the order paperwork and not the progress of field work.",
        rationale: 'Added "where is it" and "when does it arrive", plus the materials people name.',
        details:
          'Fixes the judged, nobody-found-it cases where we returned this entry nowhere: "When does the drywall for levels 2 and 3 arrive at Eastside Middle School?", "Where is the elevator rails for Eastside Middle School?", "Where is the precast stair units for Harbor Point?", "Where is the precast stair units for Riverside MOB?", "when does the curtain wall panels arrive at northgate", "When does the storefront doors arrive at Harbor Point?", "Where is the fire sprinkler pipe for Eastside Middle School?" and "Where is the elevator rails for Harbor Point?". All are model-judge cases; most returned nothing from either engine and two went to estimate_change_order. The old text was pure logistics jargon (in transit, carrier, ETA) with no "where is it", no "when does it arrive", and no material nouns, which is why plain-language questions found nothing. Nothing was deleted; the original sentence is kept intact as the opening line. The material list overlaps with the activity list I added to get_project_schedule (elevator, curtain wall); that is deliberate, because the nouns are genuinely ambiguous and the verbs do the discriminating: "where is / when does it arrive" here versus "on track / behind / are we good for" there, and both entries being in the shortlist for a truly ambiguous question is a success. I avoided writing "on track" into this entry, since it is already winning schedule questions it should not win.',
        expectedEffect:
          '"Where is X" and "when does X arrive at <project>" should return delivery tracking instead of nothing.',
      },
      get_subcontractor_compliance: {
        searchableDescription:
          "Check a subcontractor's insurance certificate, license and site safety orientation status. Use to confirm whether a named sub or trade partner is compliant and cleared to start work on site: before they mobilize, before a crew shows up Monday, before badging anyone in. Phrasings: are they compliant, are they cleared to work, can they start Monday, are they good to go, is their COI current or expired, is the certificate of insurance on file, is their license up to date, did their crew complete the safety orientation, is any paperwork missing, are they approved to mobilize. This is the company's own standing and paperwork, not the task-specific checklist for one work activity.",
        rationale:
          'Added "compliant" and "cleared to start work", and set it apart from safety checklists.',
        details:
          'Fixes the judged, nobody-found-it cases where we returned this entry nowhere and put get_safety_checklist first: "Is Ironside Erectors compliant to start work at City Hall Annex Monday?", "Is Northair Mechanical compliant to start work at Lakeview Fire Station Monday?", "Is Keystone Plumbing compliant to start work at City Hall Annex Monday?", "Is Keystone Plumbing compliant to start work at Lakeview Fire Station Monday?", "Is Granite Concrete compliant to start work at Lakeview Fire Station Monday?", "Is Peak Roofing compliant to start work at Northgate Monday?", "Is Clearview Glass compliant to start work at Eastside Middle School Monday?" and "Is Granite Concrete compliant to start work at Riverside MOB Monday?". All are model-judge cases. The old text never contained "compliant", "cleared" or "start work", while it did contain "safety", which is almost certainly why get_safety_checklist captured all eight. Nothing was deleted (insurance certificate, license and site safety orientation are all kept), and I added the clearance vocabulary plus COI, expired, missing paperwork, mobilize. The final clause names the distinction against get_safety_checklist. I did not edit get_safety_checklist itself: it is not in the losing set here, so I have no evidence about what it currently wins, and adding compliance vocabulary to it would be an untestable bet.',
        expectedEffect:
          '"Is <sub> compliant / cleared to start Monday" should return compliance instead of the pre-task safety checklist.',
      },
      notify_team: {
        searchableDescription:
          "Post a message to a project's team channel or to the safety manager. Use to send a note, heads-up, request or hand-off to a named person or role (the superintendent, project manager, foreman, purchasing, the yard, the owner's rep) or to the whole project team. Phrasings: let them know, give them a heads up, pass it on to whoever handles it, forward this along, send the request to someone, tell the super, ping the team, flag this to the PM, loop in purchasing, ask someone to follow up, just get word to them.",
        rationale: "Added sending a message to a named person or role, not only the team channel.",
        details:
          'Fixes the judged, nobody-found-it cases where we returned this entry nowhere: "Fine, just pass it on to whoever handles it." (both engines returned nothing), "Can you at least send the request to Dana Ruiz at the yard?" (both engines led with get_change_order) and "Can you at least send the request to Tom Becker in purchasing?" (we led with get_purchase_order, the incumbent with get_change_order). All three are model-judge cases. The old one-liner only described a channel post and the safety manager, so a request addressed to an individual by name or department had nothing to match on, and the surrounding nouns ("purchasing", "the yard") pulled the request to the purchase-order and change-order entries instead. Nothing was deleted; the original sentence is the opening line, and I added the hand-off and named-recipient vocabulary around it. Note that this entry appeared in our list on zero searches where something else was right, so it is under-triggering rather than over-triggering and can afford the extra phrasings.',
        expectedEffect:
          'Hand-off requests like "pass it on" or "send this to <person> in purchasing" should return the notify tool rather than a document lookup.',
      },
    },
  },
};
