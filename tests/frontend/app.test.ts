import { describe, expect, test } from 'bun:test';
import { Session } from '../../src/data/data';
import { createWorkspace, nextSessionName, setSirusModel, startSession } from '../../src/frontend/app';

describe('app workspace startup', () => {
  test('uses a collision-safe name for the startup draft', () => {
    const existing = Session.create('Session 2', '/projects/previous');

    expect(nextSessionName([existing])).toBe('Session 3');
    expect(createWorkspace({ sessions: [existing], selectedSessionId: existing.getId() }, '/projects/current')
      .draftSession.getName()).toBe('Session 3');
  });

  test('opens an unselected draft without adding it to saved sessions', () => {
    const previous = Session.create('Previous', '/projects/previous');
    previous.append({ role: 'user', content: [{ type: 'text', text: 'Existing history' }] });

    const workspace = createWorkspace({
      sessions: [previous],
      selectedSessionId: previous.getId(),
    }, '/projects/current');

    expect(workspace.sessions).toHaveLength(1);
    expect(workspace.sessions[0]).toBe(previous);
    expect(workspace.selectedSession).toBeNull();
    expect(workspace.draftSession.getDirectory()).toBe('/projects/current');
    expect(workspace.draftSession.isEmpty()).toBe(true);
  });

  test('promotes the draft to a selected session on its first message', () => {
    const workspace = createWorkspace({ sessions: [], selectedSessionId: null }, '/projects/current');
    workspace.draftSession.append({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });

    const started = startSession(workspace, workspace.draftSession, '/projects/current');

    expect(started.sessions).toEqual([workspace.draftSession]);
    expect(started.selectedSession).toBe(workspace.draftSession);
    expect(started.draftSession).not.toBe(workspace.draftSession);
    expect(started.draftSession.isEmpty()).toBe(true);
  });

  test('uses one Sirus model across saved, draft, and future sessions', () => {
    const first = new Session('First', 'first', 'gpt-5.6-luna');
    const second = new Session('Second', 'second', 'gpt-5.6-terra');
    second.addParticipant('reviewer', 'claude-fable-5');
    let workspace = createWorkspace({
      sessions: [first, second],
      selectedSessionId: second.getId(),
    }, '/projects/current', 'claude-sonnet-5');

    expect(workspace.sessions.map(session => session.getModel()))
      .toEqual(['claude-sonnet-5', 'claude-sonnet-5']);
    expect(workspace.draftSession.getModel()).toBe('claude-sonnet-5');
    expect(second.getParticipants()[1]).toEqual({ name: 'reviewer', model: 'claude-fable-5' });

    workspace = setSirusModel(workspace, 'gpt-5.6-sol');
    const started = startSession(workspace, workspace.draftSession, '/projects/current');
    expect(started.sessions.every(session => session.getModel() === 'gpt-5.6-sol')).toBe(true);
    expect(started.draftSession.getModel()).toBe('gpt-5.6-sol');
  });
});
