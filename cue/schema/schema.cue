// The shapes a brand's Mautic declarations must have — the CUE twin of src/types.d.mts.
//
// Import as "github.com/thevitya/mautic-kit/schema" (a brand's build links this directory into
// cue.mod/pkg). `cue export -e declarations` must produce JSON the engine takes as-is: no renames,
// no adapter. A field added here and not there (or the reverse) is caught by test/cue.test.mjs.
package schema

#Slug:      =~"^[a-z0-9-]+$"
#FormAlias: =~"^[a-z0-9_]{1,10}$" // Mautic truncates form aliases to 10 chars; declare one that fits.

#FieldType: "text" | "boolean" | "date"

#Field: {
	alias: string
	label: string
	type:  #FieldType
	// Mautic refuses a boolean field that declares no labels.
	if type == "boolean" {properties: {yes: string, no: string}}
	properties?: {yes: string, no: string}
}

#FilterOperator: "=" | "!=" | "gt" | "gte" | "lt" | "lte" | "like" | "!like" | "in" | "!in" | "empty" | "!empty" | "startsWith" | "endsWith" | "contains"

#Filter: {
	glue:     "and" | "or"
	field:    string
	object:   "lead" | "company"
	type:     #FieldType | "tags"
	operator: #FilterOperator
	// Valueless operators carry no filter value; every other operator requires one. For `tags`,
	// values are TAG NAMES — the engine resolves them to ids.
	if operator == "empty" || operator == "!empty" {properties?: _|_}
	properties?: {filter: _}
}

#Segment: {
	alias:        string & #Slug
	name:         string
	description:  string | *""
	filters?:     [...#Filter]
	isPublished?: bool
	isGlobal?:    bool
	projects?:    [...int]
	// Present only on a segment carrying service mail, holding the reason.
	service?: string
}

#Tag: {
	tag:           string
	"_description"?: string // a note for the reader; never sent
}

#Category: {
	alias:        string & #Slug
	title:        string
	bundle:       "email" | "form" | "asset" | "stage" | "campaign" | "page" | "segment"
	color:        string & =~"^[0-9a-f]{6}$"
	isPublished?: bool
}

#Stage: {
	name:         string
	weight:       int & >0
	description?: string
	isPublished?: bool
}

// Looked up by title, never created. `name` is the `{asset:name}` token key.
#Asset: {
	name:        string
	title:       string
	remote_url?: string
}

#FormField: {
	label: string
	alias: string
	type:  string
	order: int & >0
	...
}

#Form: {
	name:         string
	alias:        string & #FormAlias
	formType:     "campaign" | "standalone"
	description?: string | null
	isPublished?: bool
	category?:    string
	projects?:    [...int]
	fields?:      [...#FormField]
	actions?:     [...]
	...
}

#Page: {
	alias:        string & #Slug
	title:        string
	body:         string // full HTML document
	isPublished?: bool
}

#EmailDefaults: {
	language?:       string
	emailType?:      "template" | "list"
	fromName?:       string
	fromAddress?:    string
	replyToAddress?: string
}

#Email: {
	name:            string
	subject:         string
	preview?:        string | null
	category?:       string | null
	projects?:       [...int]
	emailType?:      "template" | "list"
	language?:       string
	fromName?:       string
	fromAddress?:    string
	replyToAddress?: string
	body:            string // PLAIN TEXT; rendered by the engine
	isPublished?:    bool
}

#EmailCopy: {
	subject:  string
	preview?: string
	body:     string
}

#Webhook: {
	name:         string
	description?: string
	path:         string & =~"^/"
	isPublished?: bool
	triggers: [...string]
}

#ActionType: "email.send" | "lead.changelist" | "lead.changetags" | "lead.updatelead" | "lead.changepoints" | "lead.changeowner" | "lead.addtocompany" | "lead.scorecontactscompanies" | "lead.updatecompany" | "stage.change" | "campaign.sendwebhook" | "message.send" | "plugin.leadpush" | "focus.show"
#DecisionType: "form.submit" | "page.pagehit" | "page.devicehit" | "asset.download" | "email.open"
#ConditionType: "form.field_value" | "lead.campaigns" | "lead.device" | "lead.dnc" | "lead.field_value" | "lead.owner" | "lead.pageHit" | "lead.points" | "lead.segments" | "lead.stages" | "lead.tags"

#_EventCommon: {
	id:           string
	name:         string
	description?: string
	order:        int & >0
	triggerMode:  "immediate" | "interval" | "date" | null
	triggerDate?: string | null
	// `interval` needs both; `immediate` needs neither.
	triggerInterval:     int & >=0 | *0
	triggerIntervalUnit: "i" | "h" | "d" | "w" | "m" | "y" | null
	if triggerMode == "interval" {triggerInterval: >0, triggerIntervalUnit: !=null}
	parent:       string | null
	children: [...string]
	// Which branch of a DECISION/CONDITION parent this hangs off. An action without it never fires.
	decisionPath: "yes" | "no" | null
	...
}

#CampaignEvent: #_EventCommon & ({
	type:      "email.send"
	eventType: "action"
	properties: {
		email:      string // EMAIL NAME
		email_type: "marketing" | "transactional"
		priority?:  int
		attempts?:  int
	}
} | {
	type:      "lead.changelist"
	eventType: "action"
	properties: {addToLists: [...string], removeFromLists: [...string]} // SEGMENT ALIASES
} | {
	type:      "lead.changetags"
	eventType: "action"
	properties: {add_tags: [...string], remove_tags: [...string] | *[]}
} | {
	type:      "stage.change"
	eventType: "action"
	properties: {stage: string} // STAGE NAME
} | {
	type:      "form.submit"
	eventType: "decision"
	properties: {forms: [...string]} // FORM ALIASES
} | {
	type:      "page.pagehit"
	eventType: "decision"
	properties: {pages: [...string], ...} // PAGE ALIASES
} | {
	type:      "lead.updatelead"
	eventType: "action"
	properties: [string]: string | number
} | {
	type:       #ActionType & !="email.send" & !="lead.changelist" & !="lead.changetags" & !="stage.change" & !="lead.updatelead"
	eventType:  "action"
	properties: _
} | {
	type:       #DecisionType & !="form.submit" & !="page.pagehit"
	eventType:  "decision"
	properties: _
} | {
	type:       #ConditionType
	eventType:  "condition"
	properties: _
})

#Campaign: {
	name:         string
	description?: string
	// Publishing a lifecycle campaign mails the segment's existing members — say it explicitly.
	isPublished: bool
	lists: [...string] // SEGMENT ALIASES
	forms: [...string] // FORM ALIASES
	category?:       string
	projects?:       [...int]
	events:          [...#CampaignEvent]
	canvasSettings?: _
}
