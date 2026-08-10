import Foundation
import EventKit
import Contacts

enum BridgeFailure: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let value): return value }
    }
}

func input() throws -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    if data.isEmpty { return [:] }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw BridgeFailure.message("Connector arguments must be a JSON object.")
    }
    return object
}

func output(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

func iso(_ value: Any?) throws -> Date {
    guard let text = value as? String else {
        throw BridgeFailure.message("A date-time in ISO-8601 format is required.")
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    guard let date = formatter.date(from: text) else {
        throw BridgeFailure.message("Invalid ISO-8601 date-time: \(text)")
    }
    return date
}

func isoString(_ value: Date) -> String {
    ISO8601DateFormatter().string(from: value)
}

func requestEventAccess(_ entity: EKEntityType) throws {
    let store = EKEventStore()
    let semaphore = DispatchSemaphore(value: 0)
    var allowed = false
    var requestError: Error?
    if #available(macOS 14.0, *) {
        if entity == .event {
            store.requestFullAccessToEvents { value, error in
                allowed = value; requestError = error; semaphore.signal()
            }
        } else {
            store.requestFullAccessToReminders { value, error in
                allowed = value; requestError = error; semaphore.signal()
            }
        }
    } else {
        store.requestAccess(to: entity) { value, error in
            allowed = value; requestError = error; semaphore.signal()
        }
    }
    semaphore.wait()
    if let requestError { throw requestError }
    if !allowed { throw BridgeFailure.message("Access was not granted in System Settings.") }
}

func eventStore(_ entity: EKEntityType) throws -> EKEventStore {
    try requestEventAccess(entity)
    return EKEventStore()
}

func calendarList(_ args: [String: Any]) throws -> [[String: Any]] {
    let store = try eventStore(.event)
    let start = try iso(args["start"])
    let end = try iso(args["end"])
    let limit = min(max(args["limit"] as? Int ?? 50, 1), 200)
    return store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
        .sorted { $0.startDate < $1.startDate }
        .prefix(limit)
        .map { event in
            [
                "id": event.eventIdentifier ?? "",
                "title": event.title ?? "",
                "start": isoString(event.startDate),
                "end": isoString(event.endDate),
                "allDay": event.isAllDay,
                "calendar": event.calendar.title,
                "location": event.location ?? "",
                "notes": event.notes ?? ""
            ]
        }
}

func calendarCreate(_ args: [String: Any]) throws -> [String: Any] {
    let store = try eventStore(.event)
    let event = EKEvent(eventStore: store)
    guard let title = args["title"] as? String, !title.isEmpty else {
        throw BridgeFailure.message("Event title is required.")
    }
    event.title = title
    event.startDate = try iso(args["start"])
    event.endDate = try iso(args["end"])
    event.isAllDay = args["allDay"] as? Bool ?? false
    event.location = args["location"] as? String
    event.notes = args["notes"] as? String
    if let calendarName = args["calendar"] as? String, !calendarName.isEmpty {
        event.calendar = store.calendars(for: .event).first {
            $0.title.localizedCaseInsensitiveCompare(calendarName) == .orderedSame
        } ?? store.defaultCalendarForNewEvents
    } else {
        event.calendar = store.defaultCalendarForNewEvents
    }
    try store.save(event, span: .thisEvent, commit: true)
    return ["id": event.eventIdentifier ?? "", "title": event.title ?? "", "start": isoString(event.startDate)]
}

func calendarUpdate(_ args: [String: Any]) throws -> [String: Any] {
    let store = try eventStore(.event)
    guard let id = args["id"] as? String, let event = store.event(withIdentifier: id) else {
        throw BridgeFailure.message("Calendar event not found.")
    }
    if let title = args["title"] as? String, !title.isEmpty { event.title = title }
    if let start = args["start"] as? String, !start.isEmpty { event.startDate = try iso(start) }
    if let end = args["end"] as? String, !end.isEmpty { event.endDate = try iso(end) }
    if let location = args["location"] as? String { event.location = location }
    if let notes = args["notes"] as? String { event.notes = notes }
    if let allDay = args["allDay"] as? Bool { event.isAllDay = allDay }
    try store.save(event, span: .thisEvent, commit: true)
    return ["id": event.eventIdentifier ?? id, "title": event.title ?? "", "start": isoString(event.startDate), "end": isoString(event.endDate)]
}

func calendarNames(_ entity: EKEntityType) throws -> [[String: Any]] {
    let store = try eventStore(entity)
    return store.calendars(for: entity).map {
        ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title]
    }
}

func reminderList(_ args: [String: Any]) throws -> [[String: Any]] {
    let store = try eventStore(.reminder)
    let includeCompleted = args["includeCompleted"] as? Bool ?? false
    let calendarName = args["list"] as? String
    let calendars = calendarName.flatMap { name in
        store.calendars(for: .reminder).filter {
            $0.title.localizedCaseInsensitiveCompare(name) == .orderedSame
        }
    }
    let semaphore = DispatchSemaphore(value: 0)
    var values: [EKReminder] = []
    store.fetchReminders(matching: store.predicateForReminders(in: calendars)) {
        values = $0 ?? []; semaphore.signal()
    }
    semaphore.wait()
    return values
        .filter { includeCompleted || !$0.isCompleted }
        .sorted { ($0.dueDateComponents?.date ?? .distantFuture) < ($1.dueDateComponents?.date ?? .distantFuture) }
        .prefix(200)
        .map { reminder in
            [
                "id": reminder.calendarItemIdentifier,
                "title": reminder.title ?? "",
                "completed": reminder.isCompleted,
                "due": reminder.dueDateComponents?.date.map(isoString) ?? "",
                "list": reminder.calendar.title,
                "notes": reminder.notes ?? ""
            ]
        }
}

func reminderCreate(_ args: [String: Any]) throws -> [String: Any] {
    let store = try eventStore(.reminder)
    let reminder = EKReminder(eventStore: store)
    guard let title = args["title"] as? String, !title.isEmpty else {
        throw BridgeFailure.message("Reminder title is required.")
    }
    reminder.title = title
    reminder.notes = args["notes"] as? String
    if let dueText = args["due"] as? String, !dueText.isEmpty {
        reminder.dueDateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .timeZone],
            from: try iso(dueText)
        )
    }
    if let list = args["list"] as? String, !list.isEmpty {
        reminder.calendar = store.calendars(for: .reminder).first {
            $0.title.localizedCaseInsensitiveCompare(list) == .orderedSame
        } ?? store.defaultCalendarForNewReminders()
    } else {
        reminder.calendar = store.defaultCalendarForNewReminders()
    }
    try store.save(reminder, commit: true)
    return ["id": reminder.calendarItemIdentifier, "title": reminder.title ?? "", "list": reminder.calendar.title]
}

func reminderComplete(_ args: [String: Any]) throws -> [String: Any] {
    let store = try eventStore(.reminder)
    guard let id = args["id"] as? String, let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw BridgeFailure.message("Reminder not found.")
    }
    reminder.isCompleted = true
    reminder.completionDate = Date()
    try store.save(reminder, commit: true)
    return ["id": id, "title": reminder.title ?? "", "completed": true]
}

func reminderUpdate(_ args: [String: Any]) throws -> [String: Any] {
    let store = try eventStore(.reminder)
    guard let id = args["id"] as? String, let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw BridgeFailure.message("Reminder not found.")
    }
    if let title = args["title"] as? String, !title.isEmpty { reminder.title = title }
    if let notes = args["notes"] as? String { reminder.notes = notes }
    if let due = args["due"] as? String {
        reminder.dueDateComponents = due.isEmpty ? nil : Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .timeZone],
            from: try iso(due)
        )
    }
    try store.save(reminder, commit: true)
    return ["id": id, "title": reminder.title ?? "", "due": reminder.dueDateComponents?.date.map(isoString) ?? ""]
}

func contactsSearch(_ args: [String: Any]) throws -> [[String: Any]] {
    let store = CNContactStore()
    let semaphore = DispatchSemaphore(value: 0)
    var allowed = false
    var requestError: Error?
    store.requestAccess(for: .contacts) { value, error in
        allowed = value; requestError = error; semaphore.signal()
    }
    semaphore.wait()
    if let requestError { throw requestError }
    if !allowed { throw BridgeFailure.message("Contacts access was not granted.") }
    let query = (args["query"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let keys: [CNKeyDescriptor] = [
        CNContactIdentifierKey as CNKeyDescriptor,
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        CNContactEmailAddressesKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor
    ]
    let contacts: [CNContact]
    if query.isEmpty {
        var all: [CNContact] = []
        let request = CNContactFetchRequest(keysToFetch: keys)
        try store.enumerateContacts(with: request) { contact, stop in
            all.append(contact)
            if all.count >= 100 { stop.pointee = true }
        }
        contacts = all
    } else {
        contacts = try store.unifiedContacts(
            matching: CNContact.predicateForContacts(matchingName: query),
            keysToFetch: keys
        )
    }
    return contacts.prefix(100).map { contact in
        [
            "id": contact.identifier,
            "name": CNContactFormatter.string(from: contact, style: .fullName) ?? "",
            "organization": contact.organizationName,
            "emails": contact.emailAddresses.map { $0.value as String },
            "phones": contact.phoneNumbers.map { $0.value.stringValue }
        ]
    }
}

func contactsStore() throws -> CNContactStore {
    let store = CNContactStore()
    let semaphore = DispatchSemaphore(value: 0)
    var allowed = false
    var requestError: Error?
    store.requestAccess(for: .contacts) { value, error in
        allowed = value; requestError = error; semaphore.signal()
    }
    semaphore.wait()
    if let requestError { throw requestError }
    if !allowed { throw BridgeFailure.message("Contacts access was not granted.") }
    return store
}

func contactResult(_ contact: CNContact) -> [String: Any] {
    [
        "id": contact.identifier,
        "name": CNContactFormatter.string(from: contact, style: .fullName) ?? "",
        "organization": contact.organizationName,
        "emails": contact.emailAddresses.map { $0.value as String },
        "phones": contact.phoneNumbers.map { $0.value.stringValue }
    ]
}

func contactsCreate(_ args: [String: Any]) throws -> [String: Any] {
    let store = try contactsStore()
    let contact = CNMutableContact()
    let givenName = args["givenName"] as? String ?? ""
    let familyName = args["familyName"] as? String ?? ""
    let organization = args["organization"] as? String ?? ""
    if givenName.isEmpty && familyName.isEmpty && organization.isEmpty {
        throw BridgeFailure.message("A contact name or organization is required.")
    }
    contact.givenName = givenName
    contact.familyName = familyName
    contact.organizationName = organization
    if let email = args["email"] as? String, !email.isEmpty {
        contact.emailAddresses = [
            CNLabeledValue(label: CNLabelWork, value: email as NSString)
        ]
    }
    if let phone = args["phone"] as? String, !phone.isEmpty {
        contact.phoneNumbers = [
            CNLabeledValue(label: CNLabelPhoneNumberMain, value: CNPhoneNumber(stringValue: phone))
        ]
    }
    let request = CNSaveRequest()
    request.add(contact, toContainerWithIdentifier: nil)
    try store.execute(request)
    return contactResult(contact)
}

func contactsUpdate(_ args: [String: Any]) throws -> [String: Any] {
    let store = try contactsStore()
    guard let id = args["id"] as? String, !id.isEmpty else {
        throw BridgeFailure.message("Contact identifier is required.")
    }
    let keys: [CNKeyDescriptor] = [
        CNContactIdentifierKey as CNKeyDescriptor,
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName)
    ]
    let existing = try store.unifiedContact(withIdentifier: id, keysToFetch: keys)
    guard let contact = existing.mutableCopy() as? CNMutableContact else {
        throw BridgeFailure.message("Contact could not be updated.")
    }
    if let value = args["givenName"] as? String { contact.givenName = value }
    if let value = args["familyName"] as? String { contact.familyName = value }
    if let value = args["organization"] as? String { contact.organizationName = value }
    if let value = args["email"] as? String, !value.isEmpty,
       !contact.emailAddresses.contains(where: {
           ($0.value as String).localizedCaseInsensitiveCompare(value) == .orderedSame
       }) {
        contact.emailAddresses.append(
            CNLabeledValue(label: CNLabelWork, value: value as NSString)
        )
    }
    if let value = args["phone"] as? String, !value.isEmpty,
       !contact.phoneNumbers.contains(where: { $0.value.stringValue == value }) {
        contact.phoneNumbers.append(
            CNLabeledValue(label: CNLabelPhoneNumberMain, value: CNPhoneNumber(stringValue: value))
        )
    }
    let request = CNSaveRequest()
    request.update(contact)
    try store.execute(request)
    return contactResult(contact)
}

func eventAuthorization(_ entity: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: entity) {
    case .notDetermined: return "not_determined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .fullAccess: return "full_access"
    case .writeOnly: return "write_only"
    @unknown default: return "unknown"
    }
}

func contactsAuthorization() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .notDetermined: return "not_determined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .limited: return "limited"
    @unknown default: return "unknown"
    }
}

func permissions() -> [String: Any] {
    [
        "calendar": eventAuthorization(.event),
        "reminders": eventAuthorization(.reminder),
        "contacts": contactsAuthorization()
    ]
}

do {
    guard CommandLine.arguments.count >= 2 else {
        throw BridgeFailure.message("An operation is required.")
    }
    let args = try input()
    switch CommandLine.arguments[1] {
    case "permissions": try output(permissions())
    case "calendar.calendars": try output(calendarNames(.event))
    case "calendar.list": try output(calendarList(args))
    case "calendar.create": try output(calendarCreate(args))
    case "calendar.update": try output(calendarUpdate(args))
    case "reminders.lists": try output(calendarNames(.reminder))
    case "reminders.list": try output(reminderList(args))
    case "reminders.create": try output(reminderCreate(args))
    case "reminders.update": try output(reminderUpdate(args))
    case "reminders.complete": try output(reminderComplete(args))
    case "contacts.search": try output(contactsSearch(args))
    case "contacts.create": try output(contactsCreate(args))
    case "contacts.update": try output(contactsUpdate(args))
    default: throw BridgeFailure.message("Unknown Apple connector operation.")
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
