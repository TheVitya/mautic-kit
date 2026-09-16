package schema

import "list"

// Everything one brand's Mautic holds, with the cross-references checked at `cue vet` time — the
// class of mistake Mautic accepts silently (a campaign naming an email that does not exist sends
// nothing, forever, with no error).
//
// `cue export -e declarations` is the JSON the engine reads.
#Declarations: {
	fields: [...#Field]
	subscriberTag?: string
	tags: [...#Tag]
	categories: [...#Category]
	stages: [...#Stage]
	segments: [...#Segment]
	forms: [...#Form]
	assets: [...#Asset]
	pages: [...#Page]
	globals: [string]: string
	emailDefaults?: #EmailDefaults
	footerLabels?: {unsubscribe?: string, webview?: string}
	// Inline CSS for `{token|Button}` / `{token||link}`.
	emailStyles?: {button?: string, link?: string}
	emails: [...#Email]
	emailTranslations: [string]: [string]: #EmailCopy
	campaigns: [...#Campaign]
	webhooks: [...#Webhook]

	// ----------------------------------------------------------------- uniqueness
	_uniqueEmail:    list.UniqueItems([for e in emails {e.name}]) & true
	_uniqueSegment:  list.UniqueItems([for s in segments {s.alias}]) & true
	_uniqueCampaign: list.UniqueItems([for c in campaigns {c.name}]) & true
	_uniqueForm:     list.UniqueItems([for f in forms {f.alias}]) & true

	// ----------------------------------------------------------------- references
	// Each set gets a sentinel so `or` never sees an empty list; no real name can contain `<>` here.
	let _none = "<none>"
	let _segment = or([_none, for s in segments {s.alias}])
	let _form = or([_none, for f in forms {f.alias}])
	let _tag = or([_none, if subscriberTag != _|_ {subscriberTag}, for t in tags {t.tag}])
	let _catEmail = or([_none, for c in categories if c.bundle == "email" {c.alias}])
	let _catForm = or([_none, for c in categories if c.bundle == "form" {c.alias}])
	let _catCampaign = or([_none, for c in categories if c.bundle == "campaign" {c.alias}])

	emails: [...{category?: _catEmail | null}]
	forms: [...{category?: _catForm}]
	segments: [...{filters?: [...{
		type: _
		if type == "tags" {properties?: filter: [..._tag]}
	}]}]

	campaigns: [...{
		category?: _catCampaign
		lists: [..._segment]
		forms: [..._form]
	}]

	// Event references and tree, checked in a hidden field. NOT as `if type == …` constraints on
	// `campaigns` itself: CUE resolves the event union and those guards against each other, and a
	// perfectly valid `stage.change` then fails every branch with no useful error.
	let _emails = [for e in emails {e.name}]
	let _segments = [for s in segments {s.alias}]
	let _forms = [for f in forms {f.alias}]
	let _stages = [for st in stages {st.name}]
	let _pages = [for p in pages {p.alias}]
	let _tags = [if subscriberTag != _|_ {subscriberTag}, for t in tags {t.tag}]
	// Each check's FIELD NAME says what is broken, so `cue vet` reports e.g.
	// `_refs."email.send \"nope\" in W / Send": conflicting values false and true`.
	_refs: {
		for name, _ in emailTranslations {
			"translation of unknown email \"\(name)\"": list.Contains(_emails, name) & true
		}
		for c in campaigns for ev in c.events {
			let at = "in \(c.name) / \(ev.name)"
			if ev.type == "email.send" {"email.send \"\(ev.properties.email)\" \(at)": list.Contains(_emails, ev.properties.email) & true}
			if ev.type == "stage.change" {"stage.change \"\(ev.properties.stage)\" \(at)": list.Contains(_stages, ev.properties.stage) & true}
			if ev.type == "form.submit" {for n in ev.properties.forms {"form.submit \"\(n)\" \(at)": list.Contains(_forms, n) & true}}
			if ev.type == "page.pagehit" {for n in ev.properties.pages {"page.pagehit \"\(n)\" \(at)": list.Contains(_pages, n) & true}}
			if ev.type == "lead.changelist" {for n in list.Concat([ev.properties.addToLists, ev.properties.removeFromLists]) {"lead.changelist \"\(n)\" \(at)": list.Contains(_segments, n) & true}}
			if ev.type == "lead.changetags" {for n in list.Concat([ev.properties.add_tags, ev.properties.remove_tags]) {"lead.changetags \"\(n)\" \(at)": list.Contains(_tags, n) & true}}
		}
	}

	// Event tree: parent/children name events of the SAME campaign; ids and names unique within it
	// (the engine matches live events by name, so a duplicate name would swap contact history).
	_eventTree: [for c in campaigns {
		let _ids = [for ev in c.events {ev.id}]
		uniqueIds:   list.UniqueItems(_ids) & true
		uniqueNames: list.UniqueItems([for ev in c.events {ev.name}]) & true
		refs: [for ev in c.events {
			parent: (ev.parent == null || list.Contains(_ids, ev.parent)) & true
			children: [for ch in ev.children {list.Contains(_ids, ch) & true}]
		}]
	}]
}
