package brand
import "github.com/thevitya/mautic-kit/schema"
declarations: schema.#Declarations & {
	subscriberTag: "news"
	categories: [{alias: "seq", title: "S", bundle: "email", color: "4e79a7"}, {alias: "camp", title: "C", bundle: "campaign", color: "4e79a7"}]
	stages: [{name: "Active", weight: 1}]
	segments: [{alias: "mailable", name: "M", filters: [{glue: "and", field: "tags", object: "lead", type: "tags", operator: "in", properties: filter: ["news"]}]}]
	globals: {brand_name: "B", brand_url: "https://b"}
	emails: [{name: "welcome", subject: "Hi", body: "x", category: "seq"}]
	emailTranslations: welcome: hu: {subject: "Szia", body: "y"}
	campaigns: [{
		name: "W", isPublished: false, lists: ["mailable"], forms: [], category: "camp"
		events: [
			{id: "a", name: "Send", type: "email.send", eventType: "action", order: 1, triggerMode: "immediate", triggerIntervalUnit: null, parent: null, children: ["b"], decisionPath: null, properties: {email: "welcome", email_type: "marketing"}},
			{id: "b", name: "Stage", type: "stage.change", eventType: "action", order: 2, triggerMode: "interval", triggerInterval: 1, triggerIntervalUnit: "d", parent: "a", children: ["c"], decisionPath: null, properties: stage: "Active"},
			{id: "c", name: "Move", type: "lead.changelist", eventType: "action", order: 3, triggerMode: "immediate", triggerIntervalUnit: null, parent: "b", children: ["d"], decisionPath: null, properties: {addToLists: ["mailable"], removeFromLists: []}},
			{id: "d", name: "Tag", type: "lead.changetags", eventType: "action", order: 4, triggerMode: "immediate", triggerIntervalUnit: null, parent: "c", children: [], decisionPath: null, properties: {add_tags: ["news"], remove_tags: []}},
		]
	}]
}
