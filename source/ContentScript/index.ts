/*
 * Zed Attack Proxy (ZAP) and its related source files.
 *
 * ZAP is an HTTP/HTTPS proxy for assessing web application security.
 *
 * Copyright 2022 The ZAP Development Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {browser} from 'webextension-polyfill-ts';

class ReportedObject {
  public timestamp: number;

  public type: string;

  public tagName: string;

  public id: string;

  public nodeName: string;

  public url: string;

  public xpath: string;

  public href: string | null;

  public text: string | null;

  public constructor(
    type: string,
    tagName: string,
    id: string,
    nodeName: string,
    text: string | null
  ) {
    this.timestamp = Date.now();
    this.type = type;
    this.tagName = tagName;
    this.id = id;
    this.nodeName = nodeName;
    this.text = text;
    this.url = window.location.href;
  }

  public toString(): string {
    return JSON.stringify(this);
  }

  public toShortString(): string {
    return JSON.stringify(this, function replacer(k: string, v: string) {
      if (k === 'xpath') {
        // Dont return the xpath value - it can change too often in many cases
        return undefined;
      }
      return v;
    });
  }

  // Use this for tests
  public toNonTimestampString(): string {
    return JSON.stringify(this, function replacer(k: string, v: string) {
      if (k === 'timestamp') {
        return undefined;
      }
      return v;
    });
  }
}

class ReportedStorage extends ReportedObject {
  public toShortString(): string {
    return JSON.stringify(this, function replacer(k: string, v: string) {
      if (k === 'xpath' || k === 'url' || k === 'href') {
        // Storage events are not URL specific
        return undefined;
      }
      return v;
    });
  }
}

class ReportedElement extends ReportedObject {
  public constructor(element: Element) {
    super(
      'nodeAdded',
      element.tagName,
      element.id,
      element.nodeName,
      element.textContent
    );
    if (element.tagName === 'A') {
      // This gets the full URL rather than a relative one
      const a: HTMLAnchorElement = element as HTMLAnchorElement;
      this.href = a.toString();
    } else if (element.hasAttribute('href')) {
      this.href = element.getAttribute('href');
    }
  }
}

class ReportedEvent {
  public timestamp: number;

  public eventName: string;

  public url: string;

  public count: number;

  public constructor(eventName: string) {
    this.timestamp = Date.now();
    this.eventName = eventName;
    this.url = window.location.href;
    this.count = 1;
  }

  public toString(): string {
    return JSON.stringify(this);
  }
}

const reportedObjects = new Set<string>();

const reportedEvents: {[key: string]: ReportedEvent} = {};

function reportStorage(
  name: string,
  storage: Storage,
  fn: (re: ReportedStorage) => void
): void {
  for (const key of Object.keys(storage)) {
    fn(new ReportedStorage(name, '', key, '', storage.getItem(key)));
  }
}

async function sendEventToZAP(obj: ReportedEvent): Promise<number> {
  return browser.runtime.sendMessage({
    type: 'reportEvent',
    data: obj.toString(),
  });
}

async function sendObjectToZAP(obj: ReportedObject): Promise<number> {
  return browser.runtime.sendMessage({
    type: 'reportObject',
    data: obj.toString(),
  });
}

function reportObject(repObj: ReportedObject): void {
  const repObjStr = repObj.toShortString();
  if (!reportedObjects.has(repObjStr)) {
    sendObjectToZAP(repObj);
    reportedObjects.add(repObjStr);
  }
}

function reportAllStorage(): void {
  reportStorage('localStorage', localStorage, reportObject);
  reportStorage('sessionStorage', sessionStorage, reportObject);
}

function reportPageUnloaded(): void {
  browser.runtime.sendMessage({
    type: 'reportEvent',
    data: new ReportedEvent('pageUnload').toString(),
  });
  for (const value of Object.values(reportedEvents)) {
    sendEventToZAP(value);
  }
  reportAllStorage();
}

function reportEvent(event: ReportedEvent): void {
  let existingEvent: ReportedEvent;
  existingEvent = reportedEvents[event.eventName];
  if (!existingEvent) {
    existingEvent = new ReportedEvent(event.eventName);
    reportedEvents[event.eventName] = event;
    sendEventToZAP(existingEvent);
  } else if (existingEvent.url !== window.location.href) {
    // The fragment has changed - report the old one and start a new count
    sendEventToZAP(existingEvent);
    existingEvent = new ReportedEvent(event.eventName);
    reportedEvents[event.eventName] = event;
    sendEventToZAP(existingEvent);
  } else {
    // eslint-disable-next-line no-plusplus
    existingEvent.count++;
  }
}

function reportPageForms(
  doc: Document,
  fn: (re: ReportedObject) => void
): void {
  Array.prototype.forEach.call(doc.forms, (form: HTMLFormElement) => {
    fn(new ReportedElement(form));
  });
}

function reportPageLinks(
  doc: Document,
  fn: (re: ReportedObject) => void
): void {
  Array.prototype.forEach.call(
    doc.links,
    (link: HTMLAnchorElement | HTMLAreaElement) => {
      fn(new ReportedElement(link));
    }
  );
}

function reportElements(
  collection: HTMLCollection,
  fn: (re: ReportedObject) => void
): void {
  Array.prototype.forEach.call(collection, (element: Element) => {
    fn(new ReportedElement(element));
  });
}

function reportNodeElements(
  node: Node,
  tagName: string,
  fn: (re: ReportedObject) => void
): void {
  if (node.nodeType === Node.ELEMENT_NODE) {
    reportElements((node as Element).getElementsByTagName(tagName), fn);
  }
}

function reportPageLoaded(
  doc: Document,
  fn: (re: ReportedObject) => void
): void {
  const url = window.location.href;

  if (url.indexOf('/zapCallBackUrl/') > 0) {
    // The browser has been launched from ZAP - use this URL for comms
    browser.runtime.sendMessage({
      type: 'zapDetails',
      data: {zapurl: url, zapkey: ''},
    });
    return;
  }

  browser.runtime.sendMessage({
    type: 'reportEvent',
    data: new ReportedEvent('pageLoad').toString(),
  });

  reportPageLinks(doc, fn);
  reportPageForms(doc, fn);
  reportElements(doc.getElementsByTagName('input'), fn);
  reportElements(doc.getElementsByTagName('button'), fn);
  reportStorage('localStorage', localStorage, fn);
  reportStorage('sessionStorage', sessionStorage, fn);
}

const domMutated = function domMutation(
  mutationList: MutationRecord[],
  _obs: MutationObserver
): void {
  reportEvent(new ReportedEvent('domMutation'));
  reportPageLinks(document, reportObject);
  reportPageForms(document, reportObject);
  for (const mutation of mutationList) {
    if (mutation.type === 'childList') {
      reportNodeElements(mutation.target, 'input', reportObject);
      reportNodeElements(mutation.target, 'button', reportObject);
    }
  }
};

function onLoadEventListener(): void {
  reportPageLoaded(document, reportObject);
}

window.addEventListener('load', onLoadEventListener, false);
window.onbeforeunload = reportPageUnloaded;

const observer = new MutationObserver(domMutated);
observer.observe(document, {
  attributes: true,
  childList: true,
  subtree: true,
});

// This is needed for more traditional apps
reportPageLoaded(document, reportObject);

export {
  ReportedObject,
  ReportedElement,
  reportPageLinks,
  reportPageLoaded,
  reportPageForms,
  reportNodeElements,
  reportStorage,
};