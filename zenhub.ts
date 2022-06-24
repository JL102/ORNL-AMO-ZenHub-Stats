import * as Papa from 'papaparse';
import { request, gql, GraphQLClient, batchRequests } from 'graphql-request';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import { graphql, buildSchema } from 'graphql'

// https://developers.zenhub.com/explorer
const endpoint = 'https://api.zenhub.com/public/graphql';
const workspaceIdMeasur = '5c9d18415648dd20c601ea26'; // using queryWorkspaceID
const outPath = path.join(__dirname, 'output');
const MAX_BATCHES = 5;

// Note: Retrieve GitHub IDs by sending a GET request to https://api.github.com/repos/ORNL-AMO/<repository name>
const githubIds = [
    {
        name: 'MEASUR',
        id: 80439269
    },
    {
        name: 'VERIFI',
        id: 252534096
    },
    {
        name: 'AMO-Tools-Suite',
        id: 75637129
    }
]

const queryWorkspaceID = gql`
    query getWorkspacesByRepo($githubIds: [Int!]!) {
        repositoriesByGhId(ghIds: $githubIds) {
            id
            workspacesConnection(first: 50) {
            nodes {
                id
                name
                description
                repositoriesConnection(first: 50) {
                nodes {
                    id
                    ghId
                    name
                }
                }
            }
            }
        }
    }
`;

const queryPipelinesByWorkspace = gql`
    query pipelinesByWorkspace($workspaceId: ID!) {
        workspace(id: $workspaceId) {
            name
            pipelinesConnection(first: 50){
                nodes {
                    name
                    id
                }
                totalCount
            }
        }
    }
`

const queryIssueByPipelineId = gql`
    query getIssuesByPipelineId($pipelineID: ID!, $filters: IssueSearchFiltersInput!, $after: String) {
        searchIssuesByPipeline(pipelineId: $pipelineID, filters: $filters, after: $after, first: 100) {
            totalCount
            nodes {
                id
                labels {
                    nodes {
                        name
                    }
                }
            }
            pageInfo {
                hasNextPage
                endCursor
            }
        }
    }
`

main().catch(err => console.error(err));

async function main() {
    
    if (!existsSync(outPath)) {
        await fs.mkdir(outPath);
    }
    
    const zenhubHeaders = getHeadersZenhub();
    
    const graphQLClient = new GraphQLClient(endpoint, {
        headers: zenhubHeaders
    });
    
    console.log('Retrieving list of Pipelines...');
    const pipelinesData = await graphQLClient.request(queryPipelinesByWorkspace, {
        workspaceId: workspaceIdMeasur
    });
    
    const pipelinesBase = pipelinesData.workspace.pipelinesConnection.nodes; // Pipelines are the same for each repo
    
    for (let repository of githubIds) {
        
        console.log(`\n=======\nRetrieving info for ${repository.name}...\n=======`);
        
        const pipelines = JSON.parse(JSON.stringify(pipelinesBase)); // Clone pipelines obj
        const labelList: string[] = []; // Headers for csv
        
        pipelines.forEach(pipeline => pipeline['issues'] = []); // Store the pipeline's issues through each batch
        
        let afterCursors = [];
        
        // Pagination - Each page, add to the list of issues in each pipeline
        for (let batchNum = 0; batchNum < MAX_BATCHES; batchNum++) {
            console.log(`Batch # ${batchNum + 1}...`);
        
            let requestBatch = [];
            
            for (let i = 0; i < pipelines.length; i++) {
                let pipeline = pipelines[i];
                requestBatch[i] = {
                    document: queryIssueByPipelineId,
                    variables: {
                        pipelineID: pipeline.id,
                        filters: {
                            repositoryGhIds: [repository.id],
                            displayType: 'issues' // only display issues, not PRs
                        },
                        after: afterCursors[i],
                    }
                };
            }
            
            const issuesByPipelineData = await batchRequests(endpoint, requestBatch, zenhubHeaders);
            
            for (let i = 0; i < pipelines.length; i++) {
                let pipeline = pipelines[i];
                let issuesThisPipeline = issuesByPipelineData[i].data.searchIssuesByPipeline;
                
                let issues = issuesThisPipeline.nodes;
                let count = issuesThisPipeline.totalCount;
                let after = issuesThisPipeline.pageInfo.endCursor;
                
                // store the data across the next batch(es)
                pipeline.issues.push(...issues);
                pipeline.issuesCount = count;
                afterCursors[i] = after;
            }
            
            // Stop the batches if none have hasNextPage == true
            let doContinue = issuesByPipelineData.some(itm => itm.data.searchIssuesByPipeline.pageInfo.hasNextPage);
            if (!doContinue) break;
        }
        
        for (let i = 0; i < pipelines.length; i++) {
            let pipeline = pipelines[i];
            
            let issuesMap = {};
            
            const issues = pipeline.issues;
            const count = pipeline.issuesCount
            console.log(`${pipeline.name}: Retrieved ${count} issues in total`);
            
            issuesMap['None'] = 0;
            
            // For each issue in the pipeline, go through labels & count the number of issues per label
            for (let issue of issues) {
                let labels = issue.labels.nodes;
                for (let label of labels) {
                    if (!issuesMap[label.name]) {
                        issuesMap[label.name] = 0;
                    }
                    if (!labelList.includes(label.name)) labelList.push(label.name); // for csv headers
                    issuesMap[label.name]++;
                }
                if (labels.length === 0) issuesMap['None']++;
            }
            
            // Save to the pipeline variable
            pipeline.issuesMap = issuesMap;
            pipeline.issuesCount = count;
        }
        
        labelList.sort();
        const columns = ['Pipeline', 'Total', 'None', ...labelList];
        
        // Restructure the data for a json-csv conversion
        /*
            {
                Pipeline: Needs Review,
                Total: 15,
                None: 7,
                Web: 1,
                ...etc
            }
        */
        const newData = [];
        for (let pipeline of pipelines) {
            let newDatum = pipeline.issuesMap;
            newDatum['Pipeline'] = pipeline.name;
            newDatum['Total'] = pipeline.issuesCount;
            newData.push(newDatum);
        }
        
        // Output raw data to compare against
        await attemptWrite(
            path.join(outPath, `raw_${repository.name}.json`), 
            JSON.stringify(pipelines, null, 2)
        )
        
        const csv = Papa.unparse(newData, {
            columns: columns,
        });
        
        await attemptWrite(
            path.join(outPath, `data_${repository.name}.csv`),
            csv
        );
        console.log('Data outputted');
    }
}

async function attemptWrite(path, data) {
    for (let i = 0; i < 20; i++) {
        try {
            await fs.writeFile(path, data, {encoding: 'utf-8'});
            return;
        }
        catch (err) {
            console.log(err.toString());
            console.log('Retrying in 2 seconds...');
            await timeoutPromise(2000);
        }
    }
    console.log('Could not write file. Continuing...');
}

function getHeadersZenhub() {
    let headers = {};
    
    if (process.env.zenhub_token) {
        headers = {'Authorization': `Bearer ${process.env.zenhub_token}`};
    }
    else {
        console.log(
            'WARNING: Could not find a ZenHub API key in the system environment variables.' +
            ' Please create a GraphQL Personal API Key for ZenHub' +
            ' (https://app.zenhub.com/settings/tokens)' +
            ' and then set it as an environment variable called "zenhub_token".\n'
        );
        process.exit(1);
    }
    return headers;
}

function timeoutPromise(time) {
    return new Promise((resolve, reject) => {
        setTimeout(() => resolve(undefined), time);
    })
}