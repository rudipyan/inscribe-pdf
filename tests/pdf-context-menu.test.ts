import { describe, expect, it, vi } from 'vitest';

const { getAllPdfViews } = vi.hoisted(() => ({ getAllPdfViews: vi.fn() }));
vi.mock('../src/obsidian-pdf-internals', () => ({ getAllPdfViews }));
vi.mock('obsidian', () => {
	class Base {}
	class Item {
		title = '';
		disabled = false;
		action?: () => void;
		setTitle(title: string) { this.title = title; return this; }
		setIcon() { return this; }
		setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
		onClick(action: () => void) { this.action = action; return this; }
	}
	class Menu {
		items: Item[] = [];
		showAtPosition = vi.fn();
		hide = vi.fn();
		onHide = vi.fn();
		addItem(configure: (item: Item) => void) {
			const item = new Item();
			configure(item);
			this.items.push(item);
		}
	}
	return { Plugin: Base, FileView: Base, Modal: Base, PluginSettingTab: Base, Setting: Base, Component: Base, Scope: Base,
		TFile: Base, Menu, Notice: vi.fn(), Platform: { isMacOS: true } };
});
import StudyPdf from '../src/main';

function fixture(selectedText = '') {
	const lookUp = vi.fn();
	const doc = { defaultView: { electron: { remote: { getCurrentWebContents: () => ({ showDefinitionForSelection: lookUp }) } } } };
	const target = { nodeType: 1, matches: () => false, closest: () => null };
	const view = {
		file: { path: 'article.pdf' },
		containerEl: { ownerDocument: doc, contains: (node: unknown) => node === target },
		findPageIndexForNode: () => 2,
		getPageElement: () => null,
	};
	getAllPdfViews.mockReturnValue([view]);
	const openPageNoteEditor = vi.fn();
	const plugin = Object.assign(Object.create(StudyPdf.prototype), {
		isInsideActivePopup: () => false,
		pdfPointAtPress: () => ({ x: 12, y: 34 }),
		pdfRevisionKey: vi.fn(() => 'original'),
		getOwnedNativeSelection: () => selectedText ? {
			selection: { toString: () => selectedText },
			range: { getClientRects: () => [{ left: 40, right: 50, top: 55, bottom: 65 }] },
		} : null,
		cancelPendingSelectionUpdate: vi.fn(),
		hideActiveMenu: vi.fn(),
		isCapturedPdfCurrent: () => true,
		openPageNoteEditor,
	});
	const event = {
		target, button: 2, clientX: 45, clientY: 60, composedPath: () => [target],
		preventDefault: vi.fn(), stopPropagation: vi.fn(),
	};
	plugin.openPdfContextMenu(doc, event);
	return { plugin, view, lookUp, openPageNoteEditor, event };
}

describe('PDF right-click menu', () => {
	it('waits for Add note before opening the editor at the clicked position', () => {
		const { plugin, view, openPageNoteEditor, event } = fixture();
		const menu = plugin.pdfContextMenu;
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(menu.showAtPosition).toHaveBeenCalledOnce();
		expect(openPageNoteEditor).not.toHaveBeenCalled();
		expect(menu.items[1]).toMatchObject({ title: 'Look up', disabled: true });
		menu.items[0].action();
		expect(openPageNoteEditor).toHaveBeenCalledWith({ file: view.file, path: view.file.path, pdfView: view },
			2, { x: 12, y: 34 }, { x: 45, y: 60 }, 'original');
	});

	it('uses system lookup only when the selected text is still current', () => {
		const { plugin, lookUp } = fixture('Selected phrase');
		const [, lookupItem] = plugin.pdfContextMenu.items;
		expect(lookupItem).toMatchObject({ title: 'Look up', disabled: false });
		lookupItem.action();
		plugin.getOwnedNativeSelection = () => null;
		lookupItem.action();
		expect(lookUp).toHaveBeenCalledOnce();
	});
});
