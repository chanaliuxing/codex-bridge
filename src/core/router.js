function normalizeString(value) {
  return String(value ?? "").toLowerCase();
}

function hasAnyTag(messageTags, expectedTag) {
  const set = new Set((messageTags ?? []).map((item) => String(item).toLowerCase()));
  return set.has(String(expectedTag).toLowerCase());
}

function matchesRule(message, rule) {
  if (rule.enabled === false) {
    return false;
  }

  if (rule.from && rule.from !== "*" && message.from !== rule.from) {
    return false;
  }

  if (rule.role && message.role !== rule.role) {
    return false;
  }

  if (rule.to && message.to && message.to !== rule.to) {
    return false;
  }

  const text = normalizeString(message.text);

  if (rule.contains && !text.includes(normalizeString(rule.contains))) {
    return false;
  }

  if (rule.startsWith && !text.startsWith(normalizeString(rule.startsWith))) {
    return false;
  }

  if (rule.tag && !hasAnyTag(message.tags, rule.tag)) {
    return false;
  }

  if (rule.metaEquals) {
    for (const [key, value] of Object.entries(rule.metaEquals)) {
      if ((message.meta ?? {})[key] !== value) {
        return false;
      }
    }
  }

  return true;
}

export class Router {
  constructor(routes = []) {
    this.routes = Array.isArray(routes) ? routes : [];
  }

  resolveDestinations(message) {
    if (message.to) {
      return [message.to];
    }

    const destinations = [];
    for (const route of this.routes) {
      if (!matchesRule(message, route)) {
        continue;
      }
      if (route.to) {
        destinations.push(route.to);
      }
      if (route.stop === true) {
        break;
      }
    }

    return [...new Set(destinations)];
  }
}
