import { getColor, getDefaultApplicationQuestions } from '../../config/bot.js';
import { SlashCommandBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import ApplicationService from '../../services/applicationService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logEvent, EVENT_TYPES, resolveApplicationLogChannel } from '../../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../../utils/logging/logEmbeds.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { 
    getApplicationSettings, 
    getUserApplications, 
    createApplication, 
    getApplication,
    getApplicationRoles,
    updateApplication,
    getApplicationRoleSettings
} from '../../utils/database.js';

const applicationDrafts = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, draft] of applicationDrafts.entries()) {
        if (now - (draft.updatedAt || draft.createdAt || 0) > 30 * 60 * 1000) {
            applicationDrafts.delete(key);
        }
    }
}, 10 * 60 * 1000).unref();

export function formatQuestionLabel(question, index) {
    const prefix = `Q${index + 1}: `;
    const suffix = ' *';
    const maxLen = 45;
    const allowed = maxLen - prefix.length - suffix.length;
    const cleanQ = String(question || '').trim();
    if (cleanQ.length > allowed) {
        return `${prefix}${cleanQ.substring(0, Math.max(0, allowed - 3))}...${suffix}`;
    }
    return `${prefix}${cleanQ}${suffix}`;
}

function getApplicationStatusPresentation(statusValue) {
    const normalized = typeof statusValue === 'string' ? statusValue.trim().toLowerCase() : 'unknown';
    const statusLabel =
        normalized === 'pending' ? 'In Progress' :
        normalized === 'approved' ? 'Accepted' :
        normalized === 'denied' ? 'Denied' :
        'Unknown';
    const statusEmoji =
        normalized === 'pending' ? '🟡' :
        normalized === 'approved' ? '🟢' :
        normalized === 'denied' ? '🔴' :
        '⚪';

    return { normalized, statusLabel, statusEmoji };
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName("apply")
        .setDescription("Manage role applications")
        .addSubcommand((subcommand) =>
            subcommand
                .setName("submit")
                .setDescription("Submit an application for a role")
                .addStringOption((option) =>
                    option
                        .setName("application")
                        .setDescription("The application you want to submit")
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("status")
                .setDescription("Check the status of your application")
                .addStringOption((option) =>
                    option
                        .setName("id")
                        .setDescription("Application ID (leave empty to see all)")
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("list")
                .setDescription("List available applications to apply for"),
        ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        }

        const { options, guild, member } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand !== "submit") {
            const isListCommand = subcommand === "list";
            await InteractionHelper.safeDefer(interaction, { flags: isListCommand ? [] : ["Ephemeral"] });
        }

        logger.info(`Apply command executed: ${subcommand}`, {
            userId: interaction.user.id,
            guildId: guild.id,
            subcommand
        });

        const settings = await getApplicationSettings(
            interaction.client,
            guild.id,
        );
        
        if (!settings.enabled) {
            throw createError(
                'Applications are disabled',
                ErrorTypes.CONFIGURATION,
                'Applications are currently disabled in this server.',
                { guildId: guild.id }
            );
        }

        if (subcommand === "submit") {
            await handleSubmit(interaction, settings);
        } else if (subcommand === "status") {
            await handleStatus(interaction);
        } else if (subcommand === "list") {
            await handleList(interaction);
        }
    }, { type: 'command', commandName: 'apply' })
};

export async function handleApplicationModal(interaction) {
    if (!interaction.isModalSubmit()) return;
    
    const customId = interaction.customId;
    if (!customId.startsWith('app_modal_')) return;
    
    const parts = customId.split('_');
    const roleId = parts[2];
    const isPaged = parts[3] && parts[3].startsWith('p');
    const pageIndex = isPaged ? parseInt(parts[3].replace('p', ''), 10) : 0;
    
    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    const applicationRole = applicationRoles.find(appRole => appRole.roleId === roleId);
    
    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Application configuration not found.' });
    }
    
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Role not found.' });
    }
    
    const settings = await getApplicationSettings(interaction.client, interaction.guild.id);
    let questions = settings.questions?.length ? settings.questions : getDefaultApplicationQuestions();
    const roleSettings = await getApplicationRoleSettings(interaction.client, interaction.guild.id, roleId);
    if (roleSettings.questions && roleSettings.questions.length > 0) {
        questions = roleSettings.questions;
    }
    if (!questions || questions.length === 0) {
        questions = getDefaultApplicationQuestions();
    }
    
    const totalPages = Math.ceil(questions.length / 5);
    const startIndex = pageIndex * 5;
    const endIndex = Math.min(startIndex + 5, questions.length);

    const currentAnswers = [];
    for (let i = startIndex; i < endIndex; i++) {
        let answer = '';
        try {
            answer = interaction.fields.getTextInputValue(`q${i}`)?.trim() || '';
        } catch {
            answer = '';
        }
        if (!answer || answer.length < 10) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: `Answer for Question ${i + 1} is compulsory (*) and must be at least 10 characters long.`
            });
        }
        currentAnswers.push({
            question: questions[i],
            answer: answer
        });
    }

    const draftKey = `${interaction.guild.id}_${interaction.user.id}_${roleId}`;

    if (pageIndex + 1 < totalPages) {
        const existingDraft = applicationDrafts.get(draftKey) || { answers: [] };
        const prior = existingDraft.answers || [];
        const mergedAnswers = [
            ...prior.filter(a => !currentAnswers.some(ca => ca.question === a.question)),
            ...currentAnswers
        ];

        applicationDrafts.set(draftKey, {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            roleId,
            roleName: applicationRole.name,
            questions,
            totalPages,
            answers: mergedAnswers,
            updatedAt: Date.now()
        });

        const nextPart = pageIndex + 2;
        const remainingCount = questions.length - mergedAnswers.length;
        const nextStart = (pageIndex + 1) * 5;
        const nextEnd = Math.min(nextStart + 5, questions.length);
        const upcomingQuestions = questions.slice(nextStart, nextEnd);
        const upcomingText = upcomingQuestions.map((q, idx) => `**Q${nextStart + idx + 1}.** ${q} \\*`).join('\n\n');

        const continueBtn = new ButtonBuilder()
            .setCustomId(`app_continue_${roleId}_p${pageIndex + 1}`)
            .setLabel(`Continue Application (Part ${nextPart}/${totalPages})`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('➡️');

        const row = new ActionRowBuilder().addComponents(continueBtn);

        return await interaction.reply({
            embeds: [createEmbed({
                title: `📝 Application In Progress (Part ${pageIndex + 1}/${totalPages} Complete)`,
                description: `✅ **Part ${pageIndex + 1} answers recorded.**\n\n` +
                    `**Upcoming Compulsory Questions (Part ${nextPart}):**\n` +
                    `${upcomingText}\n\n` +
                    `Please click the button below to answer Part ${nextPart}.`,
                color: 'info'
            })],
            components: [row],
            flags: ['Ephemeral']
        });
    }

    // Final page! Combine all answers
    let allAnswers = currentAnswers;
    if (pageIndex > 0) {
        const existingDraft = applicationDrafts.get(draftKey);
        const prior = existingDraft?.answers || [];
        allAnswers = [
            ...prior.filter(a => !currentAnswers.some(ca => ca.question === a.question)),
            ...currentAnswers
        ];
        applicationDrafts.delete(draftKey);
    }
    
    try {
        const application = await ApplicationService.submitApplication(interaction.client, {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            roleId: roleId,
            roleName: applicationRole.name,
            username: interaction.user.tag,
            avatar: interaction.user.displayAvatarURL(),
            answers: allAnswers
        });
        
        const embed = successEmbed(
            'Application Submitted',
            `Your application for **${applicationRole.name}** has been submitted successfully!\n\n` +
            `• **Compulsory Questions Answered:** ${allAnswers.length} (*)\n` +
            `• **Application ID:** \`${application.id}\`\n\n` +
            `You can check the status at any time with \`/apply status id:${application.id}\``
        );
        
        if (interaction.deferred || interaction.replied) {
            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [], flags: ["Ephemeral"] });
        } else {
            await interaction.reply({ embeds: [embed], components: [], flags: ["Ephemeral"] });
        }
        
        const guildConfig = await getGuildConfig(interaction.client, interaction.guild.id);
        const logChannelId = resolveApplicationLogChannel(guildConfig, roleSettings, settings);

        if (logChannelId) {
            const logMessage = await logEvent({
                client: interaction.client,
                guildId: interaction.guild.id,
                eventType: EVENT_TYPES.APPLICATION_SUBMIT,
                channelId: logChannelId,
                data: {
                    title: 'Application Submitted',
                    lines: [
                        formatLogLine('Applicant', `<@${interaction.user.id}> (${interaction.user.tag})`),
                        formatLogLine('Application', applicationRole.name),
                        formatLogLine('Role', role.name),
                        formatLogLine('Questions', `${allAnswers.length} compulsory question(s)`),
                        formatLogLine('Application ID', `\`${application.id}\``),
                    ],
                    inlineFields: [
                        { name: 'Status', value: '🟡 In Progress', inline: true },
                    ],
                    author: await resolveUserAuthor(interaction.client, interaction.user.id),
                },
            });

            if (logMessage) {
                await updateApplication(interaction.client, interaction.guild.id, application.id, {
                    logMessageId: logMessage.id,
                    logChannelId,
                });
            }
        }
        
    } catch (error) {
        logger.error('Error creating application:', {
            error: error.message,
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            roleId,
            stack: error.stack
        });
        
        await handleInteractionError(interaction, error, {
            type: 'modal',
            handler: 'application_submission'
        });
    }
}

export async function handleApplicationContinueButton(interaction) {
    if (!interaction.isButton()) return;
    const parts = interaction.customId.split('_');
    const roleId = parts[2];
    const pageIndex = parseInt(parts[3].replace('p', ''), 10);
    const draftKey = `${interaction.guild.id}_${interaction.user.id}_${roleId}`;
    const draft = applicationDrafts.get(draftKey);

    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    const applicationRole = applicationRoles.find(r => r.roleId === roleId);

    if (!applicationRole) {
        return await replyUserError(interaction, {
            type: ErrorTypes.CONFIGURATION,
            message: 'Application configuration not found. Please start over with `/apply submit`.'
        });
    }

    const settings = await getApplicationSettings(interaction.client, interaction.guild.id);
    let questions = settings.questions?.length ? settings.questions : getDefaultApplicationQuestions();
    const roleSettings = await getApplicationRoleSettings(interaction.client, interaction.guild.id, roleId);
    if (roleSettings.questions && roleSettings.questions.length > 0) {
        questions = roleSettings.questions;
    }
    if (!questions || questions.length === 0) {
        questions = getDefaultApplicationQuestions();
    }

    const totalPages = Math.ceil(questions.length / 5);
    const startIndex = pageIndex * 5;
    const endIndex = Math.min(startIndex + 5, questions.length);

    const modal = new ModalBuilder()
        .setCustomId(`app_modal_${roleId}_p${pageIndex}_${Date.now()}`)
        .setTitle(`${applicationRole.name} (Part ${pageIndex + 1}/${totalPages})`.substring(0, 45));

    for (let i = startIndex; i < endIndex; i++) {
        const label = formatQuestionLabel(questions[i], i);
        const input = new TextInputBuilder()
            .setCustomId(`q${i}`)
            .setLabel(label)
            .setPlaceholder('Enter your answer (Compulsory *)...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMinLength(10)
            .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
}

async function handleList(interaction) {
    try {
        const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
        
        if (applicationRoles.length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'No applications are currently available.' });
        }

        const embed = createEmbed({
            title: "Available Applications",
            description: "Here are the roles you can apply for:"
        });

        applicationRoles.forEach((appRole, index) => {
            const role = interaction.guild.roles.cache.get(appRole.roleId);
            embed.addFields({
                name: `${index + 1}. ${appRole.name}`,
                value: `**Role:** ${role ?`<@&${appRole.roleId}>`: 'Role not found'}\n` +
                       `**Apply with:** \`/apply submit application:"${appRole.name}"\``,
                inline: false
            });
        });

        embed.setFooter({
            text: "Use /apply submit application:<name> to apply for any of these roles."
        });

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
        logger.error('Error listing applications:', {
            error: error.message,
            guildId: interaction.guild.id,
            stack: error.stack
        });
        
        throw createError(
            'Failed to load applications',
            ErrorTypes.DATABASE,
            'Failed to load applications. Please try again later.',
            { guildId: interaction.guild.id }
        );
    }
}

async function handleSubmit(interaction, settings) {
    const applicationName = interaction.options.getString("application");
    const member = interaction.member;

    const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    
    const applicationRole = applicationRoles.find(appRole => 
        appRole.name.toLowerCase() === applicationName.toLowerCase()
    );

    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Use `/apply list` to see available applications.' });
    }

    const userApps = await getUserApplications(
        interaction.client,
        interaction.guild.id,
        interaction.user.id,
    );
    const pendingApp = userApps.find((app) => app.status === "pending");

    if (pendingApp) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You already have a pending application. Please wait for it to be reviewed.' });
    }

    const role = interaction.guild.roles.cache.get(applicationRole.roleId);
    if (!role) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'The role for this application no longer exists.' });
    }

    const modal = new ModalBuilder()
        .setCustomId(`app_modal_${applicationRole.roleId}`)
        .setTitle(`Application for ${applicationRole.name}`);

    let questions = settings.questions?.length ? settings.questions : getDefaultApplicationQuestions();
    const roleSettings = await getApplicationRoleSettings(interaction.client, interaction.guild.id, applicationRole.roleId);
    if (roleSettings.questions && roleSettings.questions.length > 0) {
        questions = roleSettings.questions;
    }
    if (!questions || questions.length === 0) {
        questions = getDefaultApplicationQuestions();
    }

    const totalPages = Math.ceil(questions.length / 5);

    if (totalPages <= 1) {
        const modal = new ModalBuilder()
            .setCustomId(`app_modal_${applicationRole.roleId}`)
            .setTitle(`Apply: ${applicationRole.name}`.substring(0, 45));

        questions.forEach((question, index) => {
            const label = formatQuestionLabel(question, index);
            const input = new TextInputBuilder()
                .setCustomId(`q${index}`)
                .setLabel(label)
                .setPlaceholder('Enter your answer (Compulsory *)...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(10)
                .setMaxLength(1000);

            const row = new ActionRowBuilder().addComponents(input);
            modal.addComponents(row);
        });

        await interaction.showModal(modal);
    } else {
        const draftKey = `${interaction.guild.id}_${interaction.user.id}_${applicationRole.roleId}`;
        applicationDrafts.set(draftKey, {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            roleId: applicationRole.roleId,
            roleName: applicationRole.name,
            questions,
            totalPages,
            answers: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        });

        const modal = new ModalBuilder()
            .setCustomId(`app_modal_${applicationRole.roleId}_p0_${Date.now()}`)
            .setTitle(`${applicationRole.name} (Part 1/${totalPages})`.substring(0, 45));

        const pageQuestions = questions.slice(0, 5);
        pageQuestions.forEach((question, idx) => {
            const label = formatQuestionLabel(question, idx);
            const input = new TextInputBuilder()
                .setCustomId(`q${idx}`)
                .setLabel(label)
                .setPlaceholder('Enter your answer (Compulsory *)...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(10)
                .setMaxLength(1000);

            const row = new ActionRowBuilder().addComponents(input);
            modal.addComponents(row);
        });

        await interaction.showModal(modal);
    }
}

async function handleStatus(interaction) {
    const appId = interaction.options.getString("id");

    if (appId) {
        const application = await getApplication(
            interaction.client,
            interaction.guild.id,
            appId,
        );

        if (!application || application.userId !== interaction.user.id) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Application not found or you do not have permission to view it.' });
        }

        const submittedAt = application?.createdAt ? new Date(application.createdAt) : null;
        const submittedAtDisplay = submittedAt && !Number.isNaN(submittedAt.getTime())
            ? submittedAt.toLocaleString()
            : 'Unknown date';
        const statusView = getApplicationStatusPresentation(application.status);
        const embed = createEmbed({
            title: `Application #${application.id} - ${application.roleName || 'Unknown Role'}`,
            description:
                `**Application ID:** \`${application.id}\`\n` +
                `**Status:** ${statusView.statusEmoji} ${statusView.statusLabel}\n` +
                `**Submitted:** ${submittedAtDisplay}`
        });

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
    } else {
        const applications = await getUserApplications(
            interaction.client,
            interaction.guild.id,
            interaction.user.id,
        );

        if (applications.length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You have not submitted any applications yet.' });
        }

        const recentApplications = applications
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .slice(0, 10);

        const embed = createEmbed({
            title: "Your Applications",
            description: `Showing ${recentApplications.length} recent application(s).`
        });

        recentApplications.forEach((application) => {
            const submittedAt = application?.createdAt ? new Date(application.createdAt) : null;
            const submittedAtDisplay = submittedAt && !Number.isNaN(submittedAt.getTime())
                ? submittedAt.toLocaleDateString()
                : 'Unknown date';
            const statusView = getApplicationStatusPresentation(application.status);

            embed.addFields({
                name: `${statusView.statusEmoji} ${application.roleName || 'Unknown Role'} (${statusView.statusLabel})`,
                value:
                    `**ID:** \`${application.id}\`\n` +
                    `**Status:** ${statusView.statusEmoji} ${statusView.statusLabel}\n` +
                    `**Submitted:** ${submittedAtDisplay}`,
                inline: true,
            });
        });

        if (applications.length > recentApplications.length) {
            embed.setFooter({ text: `Showing latest ${recentApplications.length} of ${applications.length} applications.` });
        }

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
    }
}