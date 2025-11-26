import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * 书籍接口定义
 */
interface Book {
    init(): Promise<void>;
    getTitle(chapterIndex: number): string;
    getPageContent(chapterIndex: number, pageIndex: number): string;
    getChapterPageCount(chapterIndex: number): number;
    getTotalChapters(): number;
    reloadConfig(): void;
    reformatAll(): void;
}

/**
 * 本地文件书籍实现
 */
class FileBook implements Book {
    private _chapters: string[] = [];
    private _chapterTitles: string[] = [];
    private _formattedChapters: string[][] = []; // [chapterIndex][pageIndex] -> pageContent
    
    private _linesPerPage: number = 15;
    private _charsPerLine: number = 50;
    private _filePath: string = "";

    constructor() {
        this.reloadConfig();
    }

    public reloadConfig() {
        const config = vscode.workspace.getConfiguration('vscode-reader');
        this._linesPerPage = config.get<number>('linesPerPage', 15);
        this._charsPerLine = config.get<number>('charsPerLine', 50);
        this._filePath = config.get<string>('filePath', "");
    }

    public async init(): Promise<void> {
        this._chapters = [];
        this._chapterTitles = [];
        this._formattedChapters = [];

        if (!this._filePath) {
            this.loadDefaultChapter("未配置路径", "请在设置中配置 vscode-reader.filePath 指向您的 txt 文件。");
            return;
        }

        if (!fs.existsSync(this._filePath)) {
            this.loadDefaultChapter("文件未找到", `无法找到文件: ${this._filePath}`);
            return;
        }

        try {
            const content = fs.readFileSync(this._filePath, 'utf-8');
            this.parseChapters(content);
            this.reformatAll();
        } catch (err: any) {
            this.loadDefaultChapter("读取错误", `读取文件失败: ${err.message}`);
        }
    }

    private loadDefaultChapter(title: string, content: string) {
        this._chapterTitles = [title];
        this._chapters = [content];
        this.reformatAll();
    }

    private parseChapters(content: string) {
        // 匹配 "第x章" 或 "Chapter x"
        const chapterRegex = /(^\s*第[0-9零一二三四五六七八九十百千]+[章回].*)|(^\s*Chapter\s+\d+.*)/gm;
        
        let match;
        const indices: number[] = [];
        
        while ((match = chapterRegex.exec(content)) !== null) {
            indices.push(match.index);
        }

        if (indices.length === 0) {
            this._chapterTitles = ["全书"];
            this._chapters = [content];
            return;
        }

        for (let i = 0; i < indices.length; i++) {
            const startIndex = indices[i];
            const endIndex = (i + 1 < indices.length) ? indices[i + 1] : content.length;
            const rawSection = content.substring(startIndex, endIndex);
            
            const firstLineEnd = rawSection.indexOf('\n');
            let title = rawSection.substring(0, firstLineEnd > 0 ? firstLineEnd : rawSection.length).trim();
            // 标题原始截断（后续在UI层再进行显示截断）
            if (title.length > 50) title = title.substring(0, 50) + "...";

            this._chapterTitles.push(title);
            this._chapters.push(rawSection);
        }
        
        if (indices[0] > 0) {
            const preContent = content.substring(0, indices[0]).trim();
            if (preContent.length > 0) {
                this._chapterTitles.unshift("序言/前言");
                this._chapters.unshift(preContent);
            }
        }
    }

    public reformatAll() {
        this._formattedChapters = [];
        this._chapters.forEach(chapterText => {
            this._formattedChapters.push(this.formatAndPaginate(chapterText));
        });
    }

    private formatAndPaginate(fullText: string): string[] {
        const lines: string[] = [];
        let currentLine = "";

        for (let i = 0; i < fullText.length; i++) {
            const char = fullText[i];
            
            if (char === '\n') {
                if (currentLine.trim().length > 0 || (lines.length > 0 && lines[lines.length - 1].trim().length > 0)) {
                    lines.push(currentLine);
                }
                currentLine = "";
                continue;
            }
            
            if (char === '\r') continue;

            currentLine += char;
            
            if (currentLine.length >= this._charsPerLine) {
                lines.push(currentLine);
                currentLine = "";
            }
        }
        if (currentLine) lines.push(currentLine);

        if (lines.length === 0) return ["(本章空)"];

        const pages: string[] = [];
        for (let i = 0; i < lines.length; i += this._linesPerPage) {
            pages.push(lines.slice(i, i + this._linesPerPage).join('\n'));
        }

        return pages;
    }

    public getTitle(index: number): string {
        return this._chapterTitles[index] || "";
    }

    public getPageContent(chapterIndex: number, pageIndex: number): string {
        const pages = this._formattedChapters[chapterIndex];
        return pages ? (pages[pageIndex] || "") : "";
    }

    public getChapterPageCount(chapterIndex: number): number {
        const pages = this._formattedChapters[chapterIndex];
        return pages ? pages.length : 0;
    }

    public getTotalChapters(): number {
        return this._chapters.length;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const book = new FileBook();
    const reader = new Reader(book, context.globalState);

    // 异步初始化
    book.init().then(() => {
        console.log("vscode-reader: Book initialized");
        reader.restoreProgress();
    });

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, reader),
        reader,
        vscode.commands.registerCommand('vscode-reader.toggle', () => reader.toggle()),
        vscode.commands.registerCommand('vscode-reader.nextChapter', () => reader.next()),
        vscode.commands.registerCommand('vscode-reader.prevChapter', () => reader.prev()),
        
        // 配置监听
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('vscode-reader')) return;

            book.reloadConfig();
            
            if (e.affectsConfiguration('vscode-reader.filePath')) {
                book.init().then(() => {
                    reader.reset();
                    reader.reload();
                    vscode.window.showInformationMessage('小说文件已重新加载');
                });
            } else {
                // 仅排版变化
                book.reformatAll();
                reader.reload();
            }
        })
    );
}

export function deactivate() {}

class Reader implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private _isEnabled: boolean = false;
    private _currentChapterIndex: number = 0;
    private _currentPageIndex: number = 0;
    private _statusBarItem: vscode.StatusBarItem;

    private readonly STORAGE_KEY_CHAPTER = 'reader.chapterIndex';
    private readonly STORAGE_KEY_PAGE = 'reader.pageIndex';

    constructor(
        private readonly _book: Book,
        private readonly _storage: vscode.Memento
    ) {
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this._statusBarItem.command = 'vscode-reader.toggle';
        this._statusBarItem.tooltip = "点击关闭阅读模式";
    }

    public dispose() {
        this._statusBarItem.dispose();
    }

    public restoreProgress() {
        this._currentChapterIndex = this._storage.get<number>(this.STORAGE_KEY_CHAPTER, 0);
        this._currentPageIndex = this._storage.get<number>(this.STORAGE_KEY_PAGE, 0);
        this.checkBoundary();
    }

    private saveProgress() {
        this._storage.update(this.STORAGE_KEY_CHAPTER, this._currentChapterIndex);
        this._storage.update(this.STORAGE_KEY_PAGE, this._currentPageIndex);
    }

    public reset() {
        this._currentChapterIndex = 0;
        this._currentPageIndex = 0;
        this.saveProgress();
    }

    public reload() {
        this.checkBoundary();
        this.refreshContent();
    }

    /**
     * 边界检查，防止页码/章节溢出
     */
    private checkBoundary() {
        const totalChapters = this._book.getTotalChapters();
        if (this._currentChapterIndex >= totalChapters) {
            this._currentChapterIndex = 0;
            this._currentPageIndex = 0;
            return;
        }
        const totalPages = this._book.getChapterPageCount(this._currentChapterIndex);
        if (this._currentPageIndex >= totalPages) {
            this._currentPageIndex = Math.max(0, totalPages - 1);
        }
    }

    public toggle() {
        this._isEnabled = !this._isEnabled;
        if (this._isEnabled) {
            this.updateStatusBar();
            this._statusBarItem.show();
            vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        } else {
            this._statusBarItem.hide();
            vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
        }
    }

    public next() {
        const totalPages = this._book.getChapterPageCount(this._currentChapterIndex);
        
        if (this._currentPageIndex < totalPages - 1) {
            this._currentPageIndex++;
            this.saveProgress();
            this.refreshContent();
        } else {
            if (this._currentChapterIndex < this._book.getTotalChapters() - 1) {
                this._currentChapterIndex++;
                this._currentPageIndex = 0;
                this.saveProgress();
                this.refreshContent();
            } else {
                this.showTempMessage('$(warning) 已经是全书最后一页');
            }
        }
    }

    public prev() {
        if (this._currentPageIndex > 0) {
            this._currentPageIndex--;
            this.saveProgress();
            this.refreshContent();
        } else {
            if (this._currentChapterIndex > 0) {
                this._currentChapterIndex--;
                this._currentPageIndex = this._book.getChapterPageCount(this._currentChapterIndex) - 1;
                this.saveProgress();
                this.refreshContent();
            } else {
                this.showTempMessage('$(warning) 已经是全书第一页');
            }
        }
    }

    private refreshContent() {
        this.updateStatusBar();
        if (this._isEnabled) {
            // 保持 Promise 链式调用以确保时序
            vscode.commands.executeCommand('editor.action.inlineSuggest.hide').then(() => {
                vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            });
        }
    }

    private updateStatusBar() {
        let title = this._book.getTitle(this._currentChapterIndex);
        // 限制标题长度，节省空间
        if (title.length > 8) {
            title = title.substring(0, 8) + '...';
        }
        
        const totalPages = this._book.getChapterPageCount(this._currentChapterIndex);
        this._statusBarItem.text = `$(book) ${title} (${this._currentPageIndex + 1}/${totalPages})`;
    }
    
    private showTempMessage(msg: string) {
        vscode.window.setStatusBarMessage(msg, 2000);
    }

    public provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
        
        if (!this._isEnabled) {
            return [];
        }

        const text = this._book.getPageContent(this._currentChapterIndex, this._currentPageIndex);
        const item = new vscode.InlineCompletionItem(text);
        item.range = new vscode.Range(position, position);
        return [item];
    }
}
