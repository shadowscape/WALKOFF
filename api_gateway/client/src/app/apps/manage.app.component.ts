import { Component, ViewEncapsulation, OnInit, OnDestroy} from '@angular/core';
import 'rxjs/Rx';
import * as Fuse from 'fuse.js';
import { saveAs } from 'file-saver';
import { UUID } from 'angular2-uuid';
import { Router, ActivatedRoute } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { FormControl } from '@angular/forms';
import { plainToClass } from 'class-transformer';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { AuthService } from '../auth/auth.service';
import { PlaybookService } from '../playbook/playbook.service';
import { UtilitiesService } from '../utilities.service';
import { GlobalsService } from '../globals/globals.service';
import { SettingsService } from '../settings/settings.service';
import { Workflow } from '../models/playbook/workflow';
import { WorkflowStatuses } from '../models/execution/workflowStatus';
import { MetadataModalComponent } from '../playbook/metadata.modal.component';
import { ImportModalComponent } from '../playbook/import.modal.component';
import { WorkflowStatusEvent } from '../models/execution/workflowStatusEvent';
import { AppService } from './app.service';
import { AppApi } from '../models/api/appApi';
import * as CodeMirror from 'codemirror'

//import $ from "jquery";  // CSS or LESS
import { createTree } from 'jquery.fancytree';
import 'jquery.fancytree/dist/modules/jquery.fancytree.edit';
import 'jquery.fancytree/dist/modules/jquery.fancytree.filter';

@Component({
	selector: 'manage-app-component',
	templateUrl: './manage.app.html',
	styleUrls: [
		'./manage.app.scss',
	],
	encapsulation: ViewEncapsulation.None,
	providers: [AuthService, GlobalsService, SettingsService],
})
export class ManageAppComponent implements OnInit, OnDestroy {
	workflowsLoaded: boolean = false;
	workflows: Workflow[] = [];
	eventSource: any;
	filterQuery: FormControl = new FormControl();
	filteredWorkflows: Workflow[] = [];

    apps: AppApi[];
    currentApp: AppApi;
    content: string;

    options: any = {
        lineNumbers: true,
        //theme: 'darcula'
    }

	constructor(
		private playbookService: PlaybookService, private authService: AuthService,
		private appService: AppService, private activeRoute: ActivatedRoute,
		private toastrService: ToastrService, private utils: UtilitiesService, 
		private modalService: NgbModal, private router: Router
	) {}

	/**
	 * On component initialization, we grab arrays of globals, app apis, and playbooks/workflows (id, name pairs).
	 * We also initialize an EventSoruce for Action Statuses for the execution results table.
	 * Also initialize cytoscape event bindings.
	 */
	ngOnInit(): void {
		this.appService.getApis().then(apps => this.apps = apps);
		
		this.getPlaybooksWithWorkflows();
		this.filterQuery
			.valueChanges
			.debounceTime(500)
            .subscribe(() => this.filterWorkflows());
            
        this.activeRoute.params.subscribe(params => {
            if (params.appId) {
                this.appService.getApi(params.appId).then(app => {
                    this.currentApp = app;
                    this.appService.listFiles(app).then(files => {
                        const tree = createTree('#tree', {
                            extensions: ['edit', 'filter'],
                            source: files,
                            activate: (event, data) => (data.node.folder) ? '' : this.loadFile(data.node.data.path)
                        });
                    });
                });
            }
        })
    }
    
    loadFile(path: string) {
        this.appService.getFile(this.currentApp, path).then(content => {
            this.content = content;
            this.options.mode = (CodeMirror as any).findModeByFileName(path).mode;
        });

    }

	/**
	 * Closes our SSEs on component destroy.
	 */
	ngOnDestroy(): void {
		if (this.eventSource && this.eventSource.close) { this.eventSource.close(); }
	}

	///------------------------------------------------------------------------------------------------------
	/// Playbook CRUD etc functions
	///------------------------------------------------------------------------------------------------------
	/**
	 * Sets up the EventStream for receiving stream actions from the server. Binds various events to the event handler.
	 * Will currently return ALL stream actions and not just the ones manually executed.
	 */
	getWorkflowStatusSSE(executionId: string) {
		if (this.eventSource) this.eventSource.close();

		return this.authService.getEventSource(`api/streams/workflowqueue/workflow_status`)
			.then(eventSource => {
				this.eventSource = eventSource;
				this.eventSource.onerror = (e: any) => this.eventSource.close();
				Object.values(WorkflowStatuses)
					  .forEach(status => this.eventSource.addEventListener(status, (e: any) => this.workflowStatusEventHandler(e, executionId)));
			})
	}

	/**
	 * Handles an EventSource message for Workflow Status.
	 * Updates existing workflow statuses for status updates or adds new ones to the list for display.
	 * @param message EventSource message for workflow status
	 */
	workflowStatusEventHandler(message: any, executionId: string): void {
		const workflowStatusEvent = plainToClass(WorkflowStatusEvent, (JSON.parse(message.data) as object));

		if (executionId != workflowStatusEvent.execution_id) return;

		switch (workflowStatusEvent.status) {
			case WorkflowStatuses.COMPLETED:
				this.eventSource.close();
				this.toastrService.success(`<b>${workflowStatusEvent.name}</b> completed`);
				break;
			case WorkflowStatuses.ABORTED:
				this.eventSource.close();
				this.toastrService.warning(`<b>${workflowStatusEvent.name}</b> aborted`)
				break;
		}
	}

	/**
	 * Executes the loaded workflow as it exists on the server. Will not currently execute the workflow as it stands.
	 */
	async executeWorkflow(workflow: Workflow): Promise<void> {
		try {
			const executionId = UUID.UUID();
			await this.getWorkflowStatusSSE(executionId);
			await this.playbookService.addWorkflowToQueue(workflow.id, executionId);
			this.toastrService.success(`Starting <b>${workflow.name}</b>`)
		}
		catch(e) {
			this.toastrService.error(`Error starting <b>${workflow.name}</b>: ${e.message}`)
		}
	}

	manageApp(app: AppApi): void {
		this.router.navigateByUrl(`/apps/${ app.id }`);
	}

	/**
	 * Gets a list of all the loaded playbooks along with their workflows.
	 */
	getPlaybooksWithWorkflows(): void {
		this.playbookService.getWorkflows()
			.then(workflows => {
				this.workflowsLoaded = true;
				this.workflows = workflows;
				this.filterWorkflows();

				this.playbookService.workflowsChange.subscribe(workflows => {
					this.workflows = workflows
					this.filterWorkflows();
				});
			});
	}
	/**
	 * Downloads a playbook as a JSON representation.
	 * @param event JS Event fired from button
	 * @param playbook Playbook to export (id, name pair)
	 */
	async exportWorkflow(workflow: Workflow) {
		try {
			const blob = await this.playbookService.exportWorkflow(workflow.id);
			saveAs(blob, `${workflow.name}.json`);
		}
		catch(e) {
			this.toastrService.error(`Error exporting workflow "${workflow.name}": ${e.message}`);
		}
	}

	/**
	 * Opens a modal to add a new workflow to a given playbook or under a new playbook.
	 */
	createWorkflow(): void {
		const modalRef = this.modalService.open(MetadataModalComponent);
		modalRef.componentInstance.workflow = new Workflow();
		modalRef.componentInstance.currentTags = this.currentTags;
		modalRef.componentInstance.existingWorkflows = this.workflows;
		modalRef.result.then(workflow => {
			this.playbookService.workflowToCreate = workflow;
			this.router.navigateByUrl(`/workflows/new`);
		}).catch(() => null)
	}

	/**
	 * Opens a modal to add a new workflow to a given playbook or under a new playbook.
	 */
	async editDescription(workflow: Workflow): Promise<void> {
		workflow = await this.playbookService.loadWorkflow(workflow.id);
		const modalRef = this.modalService.open(MetadataModalComponent);
		modalRef.componentInstance.existing = true;
		modalRef.componentInstance.workflow = workflow;
		modalRef.componentInstance.currentTags = this.currentTags;
		modalRef.componentInstance.existingWorkflows = this.workflows;
		modalRef.result.then(w => {
			this.playbookService.saveWorkflow(w)
				.then(w => this.toastrService.success(`Updated <b>${workflow.name}</b>`))
				.catch(e => this.toastrService.error(`Error loading workflow "${workflow.name}": ${e.message}`));
		}).catch(() => null)
	}

	async duplicateWorkflow(workflow: Workflow) {
		let name = await this.utils.prompt('Enter a name for the duplicate workflow');

		try {
			const duplicateWorkflow: Workflow = await this.playbookService.duplicateWorkflow(workflow.id, name);
			this.toastrService.success(`Duplicated <b>${ duplicateWorkflow.name }</b>`);
		}
		catch(e) {
			this.toastrService.error(`Error duplicating workflow "${ name }": ${e.message}`);
		}
	}

	/**
	 * Opens a modal to delete a given workflow and performs the delete action on submit.
	 * @param playbook Playbook the workflow resides under
	 * @param workflow Workflow to delete
	 */
	async deleteWorkflow(workflow: Workflow) {
		await this.utils.confirm(`Are you sure you want to delete <b>${workflow.name}</b>?`);

		try {
			await this.playbookService.deleteWorkflow(workflow.id);
			this.toastrService.success(`Deleted <b>${workflow.name}</b>`);
		}
		catch(e) {
			this.toastrService.error(`Error deleting "${workflow.name}": ${e.message}`)
		}
	}

	importWorkflow() {
		const modalRef = this.modalService.open(ImportModalComponent);
		modalRef.result.then(importFile => {
			this.playbookService.importWorkflow(importFile).then(workflow => {
				this.toastrService.success(`Imported <b>${workflow.name}</b>`);
			}).catch(e => {
				this.toastrService.error(`Error importing workflow "${importFile.name}": ${e.message}`)
			})
		}).catch(() => null)
	}

	filterWorkflows() {
		const searchFilter = this.filterQuery.value ? this.filterQuery.value.toLocaleLowerCase() : '';
		const fuse = new Fuse(this.workflows, { tokenize: true,  matchAllTokens: true, threshold: 0.5, keys: ['name', 'description', 'tags']})
		this.filteredWorkflows = (searchFilter) ? fuse.search(searchFilter.trim()) : this.workflows;
	}

	get currentTags(): string[] {
		let tags = [];
		this.workflows.forEach(w => tags = tags.concat(w.tags));
		return tags.filter((v, i, a) => a.indexOf(v) == i);
	}
}